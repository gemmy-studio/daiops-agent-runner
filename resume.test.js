/**
 * T5 resume_from_seq 흐름 테스트.
 * SDK는 mock하지 않고, EventBuffer + handleResume의 SSE replay 로직만 검증.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:http'

const TMP = path.join(os.tmpdir(), `agent-runner-resume-test-${Date.now()}`)
process.env.AGENT_RUNNER_BUFFER_DIR = TMP

const { appendEvent, forceCleanup } = await import('./event-buffer.js')

// resume 로직만 격리 테스트 — handler.js의 handleResume과 같은 로직을 inline 재현.
// (handler.js 내부 export가 아니므로 동일 동작을 재구현해 검증)
async function handleResumeForTest(sessionId, fromSeq, res) {
  const { getBufferState, getEventsSince, ensureBuffer, forceCleanup } = await import('./event-buffer.js')
  let bufState = getBufferState(sessionId)
  if (!bufState) {
    // handler.js #5: 인메모리 buffer 부재 = 재시작 → 영속 파일에서 *완료된* 턴만 복원(done-only).
    const restored = await ensureBuffer(sessionId)
    if (restored.events.length > 0 && restored.done) {
      bufState = restored
    } else {
      await forceCleanup(sessionId)
      res.writeHead(410, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Session buffer gone', session_id: sessionId }))
      return
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  const events = getEventsSince(sessionId, fromSeq)
  for (const evt of events) {
    const payload = { ...evt.data, seq: evt.seq, session_id: sessionId }
    res.write(`event: ${evt.event}\nid: ${evt.seq}\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  if (bufState.done) {
    res.end()
    return
  }

  // 활성 세션이 없으면 즉시 종료(테스트 단순화)
  res.end()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  if (req.method === 'POST' && url.pathname === '/v1/chat') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {}
      const resumeSessionId = typeof body.resume_session_id === 'string' ? body.resume_session_id : ''
      const fromSeq = typeof body.from_seq === 'number' ? body.from_seq : 0
      if (resumeSessionId) {
        await handleResumeForTest(resumeSessionId, fromSeq, res)
        return
      }
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'test only supports resume' }))
    })
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

let baseUrl = ''

before(async () => {
  await fs.mkdir(TMP, { recursive: true })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${addr.port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(TMP, { recursive: true, force: true })
})

async function readSseStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const lines = block.split('\n')
      const evt = {}
      for (const line of lines) {
        if (line.startsWith('event:')) evt.event = line.slice(6).trim()
        else if (line.startsWith('id:')) evt.id = parseInt(line.slice(3).trim(), 10)
        else if (line.startsWith('data:')) evt.data = JSON.parse(line.slice(5).trim())
      }
      if (evt.event) events.push(evt)
    }
  }
  return events
}

test('resume 미존재 세션 → 410 Gone', async () => {
  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume_session_id: 'never-existed', from_seq: 0 }),
  })
  assert.equal(res.status, 410)
})

test('resume from_seq=0 → 모든 이벤트 replay', async () => {
  const sid = 'resume-test-A'
  appendEvent(sid, 'text', { content: 'first' })
  appendEvent(sid, 'tool_use', { name: 'Bash' })
  appendEvent(sid, 'text', { content: 'final' })
  appendEvent(sid, 'done', { content: 'final' })

  await new Promise((r) => setTimeout(r, 30))

  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume_session_id: sid, from_seq: 0 }),
  })
  assert.equal(res.status, 200)
  const events = await readSseStream(res)
  assert.equal(events.length, 4)
  assert.equal(events[0].event, 'text')
  assert.equal(events[0].id, 1)
  assert.equal(events[0].data.seq, 1)
  assert.equal(events[0].data.session_id, sid)
  assert.equal(events[3].event, 'done')

  await forceCleanup(sid)
})

test('resume from_seq=2 → seq 3 이후만 replay', async () => {
  const sid = 'resume-test-B'
  appendEvent(sid, 'a', {})
  appendEvent(sid, 'b', {})
  appendEvent(sid, 'c', {})
  appendEvent(sid, 'done', {})

  await new Promise((r) => setTimeout(r, 30))

  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume_session_id: sid, from_seq: 2 }),
  })
  const events = await readSseStream(res)
  assert.equal(events.length, 2)
  assert.equal(events[0].event, 'c')
  assert.equal(events[0].id, 3)
  assert.equal(events[1].event, 'done')

  await forceCleanup(sid)
})

test('resume from_seq가 lastSeq와 같으면 빈 stream + done 처리', async () => {
  const sid = 'resume-test-C'
  appendEvent(sid, 'tick', {})
  appendEvent(sid, 'done', {})
  await new Promise((r) => setTimeout(r, 30))

  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume_session_id: sid, from_seq: 2 }),
  })
  const events = await readSseStream(res)
  assert.equal(events.length, 0)

  await forceCleanup(sid)
})

// #5 — 샌드박스 재시작: 인메모리 buffer는 사라졌지만 영속 파일이 남은 경우.
// 재시작을 시뮬레이션하기 위해 appendEvent(인메모리 채움) 대신 .jsonl 파일을 직접 쓴다.
function bufferFilePath(sid) {
  return path.join(TMP, `agent-runner-events-${sid}.jsonl`)
}
async function writeBufferFile(sid, events) {
  const lines = events.map((e, i) => JSON.stringify({
    seq: i + 1, sessionId: sid, event: e.event, data: e.data ?? {}, ts: Date.now(),
  }))
  await fs.writeFile(bufferFilePath(sid), lines.join('\n') + '\n', 'utf-8')
}

test('재시작 후 done 파일 복원 → 200 + 완료 턴 replay (#5)', async () => {
  const sid = 'resume-restart-done'
  // 인메모리 Map을 거치지 않고 파일만 존재 = 재시작 후 상태.
  await writeBufferFile(sid, [
    { event: 'text', data: { content: 'hello' } },
    { event: 'text', data: { content: 'world' } },
    { event: 'done', data: { content: 'world' } },
  ])

  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume_session_id: sid, from_seq: 0 }),
  })
  assert.equal(res.status, 200)
  const events = await readSseStream(res)
  assert.equal(events.length, 3)
  assert.equal(events[0].event, 'text')
  assert.equal(events[0].id, 1)
  assert.equal(events[2].event, 'done')

  await forceCleanup(sid)
})

test('재시작 후 done 없는(진행 중) 파일 → 410 + 파일 정리 (#5)', async () => {
  const sid = 'resume-restart-partial'
  await writeBufferFile(sid, [
    { event: 'text', data: { content: 'partial' } },
    { event: 'tool_use', data: { name: 'Bash' } },
  ])

  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume_session_id: sid, from_seq: 0 }),
  })
  assert.equal(res.status, 410)

  // 재부착 불가한 진행 중 buffer는 파일까지 정리됐는지 확인.
  await assert.rejects(() => fs.access(bufferFilePath(sid)))
})
