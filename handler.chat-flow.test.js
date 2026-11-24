/**
 * handleChat 흐름 시험(트랙 G5, 2026-11-25). 2단계 커버리지에서 handleChat(약 1,030줄)은 어떤 시험도 닿지 않았다.
 *
 * 가짜 LLM 프록시: 전역 fetch 를 바꿔 끼워 Anthropic Messages SSE 를 돌려준다. 응답은 실제 res 대신 쓴 것을
 * 모으는 가짜 객체로 받는다. 보는 것은 대화 한 턴의 바깥 계약이다: 어떤 SSE 이벤트가 어떤 순서로 나오고,
 * 응답이 닫히고, 오류는 어떤 category 로 나가는가(ADR 64 「러너 → cloud: code 와 category 를 함께」).
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP = path.join(os.tmpdir(), `agent-runner-chatflow-${process.pid}`)
process.env.AGENT_RUNNER_BUFFER_DIR = path.join(TMP, 'events')
process.env.AGENT_RUNNER_LOG_DIR = path.join(TMP, 'logs')
process.env.LLM_PROXY_URL = 'http://llm.test/api/internal/llm/messages'
process.env.AGENT_RUNNER_TOKEN = 'tok'

const { handleChat } = await import('./handler.js')

const realFetch = globalThis.fetch
/** @type {Array<{url: string, body: any}>} */
let llmCalls = []
/** @type {Array<() => Response>} */
let llmQueue = []

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}
function streamResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream' } })
}
function textTurn(text) {
  return () => streamResponse(sse([
    { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]))
}
function toolTurn(name, input, id = 'tu1') {
  return () => streamResponse(sse([
    { type: 'message_start', message: { id: 'm2', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]))
}
function errorTurn(status, message) {
  return () => new Response(JSON.stringify({ type: 'error', error: { type: 'x', message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fakeRes() {
  const chunks = []
  return {
    chunks,
    status: 0,
    writableEnded: false,
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true; return this },
    setHeader() {},
    write(chunk) { chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk) chunks.push(String(chunk)); this.writableEnded = true },
    on() { return this },
    once() { return this },
    get events() {
      return chunks.join('').split('\n\n').filter(Boolean).map((block) => {
        const event = block.match(/^event: (.+)$/m)?.[1]
        const data = block.match(/^data: (.+)$/m)?.[1]
        return { event, data: data ? JSON.parse(data) : null }
      }).filter((e) => e.event)
    },
  }
}
const fakeReq = () => ({ on() { return this }, once() { return this } })

before(async () => {
  await fs.mkdir(TMP, { recursive: true })
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/llm/messages')) {
      llmCalls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null })
      const next = llmQueue.shift()
      if (!next) throw new Error('가짜 LLM: 준비한 응답이 없다')
      return next()
    }
    // 인제스트 등 cloud 로 가는 그 밖의 호출은 받기만 한다
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
})
after(async () => {
  globalThis.fetch = realFetch
  await fs.rm(TMP, { recursive: true, force: true })
})
beforeEach(() => {
  llmCalls = []
  llmQueue = []
})

const names = (res) => res.events.map((e) => e.event)

describe('handleChat 흐름', () => {
  it('글 답 한 턴: text 가 흐르고 done 으로 끝나며 응답이 닫힌다', async () => {
    llmQueue.push(textTurn('안녕하세요'))
    const res = fakeRes()
    await handleChat({ message: '안녕', session_id: 'flow-text' }, res, fakeReq())
    assert.equal(res.status, 200)
    assert.equal(res.writableEnded, true)
    const ev = names(res)
    assert.ok(ev.includes('done'), ev.join(','))
    assert.equal(ev.at(-1), 'done')
    const text = res.events.filter((e) => e.event === 'text' || e.event === 'text_delta').map((e) => e.data.content ?? e.data.text ?? e.data.delta ?? '').join('')
    assert.match(text, /안녕하세요/)
    assert.equal(llmCalls.length, 1)
    assert.equal(llmCalls[0].body.messages.at(-1).role, 'user')
  })

  it('보낸 system_prompt 와 model 이 LLM 요청에 실린다', async () => {
    llmQueue.push(textTurn('ok'))
    const res = fakeRes()
    await handleChat({ message: 'hi', session_id: 'flow-params', system_prompt: 'SYS-MARK', model: 'claude-test-model' }, res, fakeReq())
    const body = llmCalls[0].body
    assert.equal(body.model, 'claude-test-model')
    assert.match(JSON.stringify(body.system), /SYS-MARK/)
  })

  it('LLM 이 429 를 한 번 내면 다시 시도하고 끝난다', async () => {
    llmQueue.push(errorTurn(429, 'rate limited'), textTurn('되었습니다'))
    const res = fakeRes()
    await handleChat({ message: 'hi', session_id: 'flow-retry' }, res, fakeReq())
    assert.equal(llmCalls.length, 2)
    assert.equal(names(res).at(-1), 'done')
  })

  it('LLM 이 401 을 내면 다시 시도하지 않고 category 를 단 error 로 끝난다', async () => {
    llmQueue.push(errorTurn(401, 'invalid key'))
    const res = fakeRes()
    await handleChat({ message: 'hi', session_id: 'flow-auth' }, res, fakeReq())
    assert.equal(llmCalls.length, 1)
    const err = res.events.find((e) => e.event === 'error')
    assert.ok(err, names(res).join(','))
    assert.ok(err.data.category, JSON.stringify(err.data))
    assert.equal(res.writableEnded, true)
  })

  it('도구 호출 한 번: tool_use, tool_result 를 내고 결과를 실어 두 번째 턴으로 이어 간다', async () => {
    const file = path.join(TMP, 'note.txt')
    await fs.writeFile(file, 'NOTE-CONTENT')
    llmQueue.push(toolTurn('Read', { file_path: file }), textTurn('읽었습니다'))
    const res = fakeRes()
    await handleChat({ message: '읽어 줘', session_id: 'flow-tool', context_dir: TMP }, res, fakeReq())
    const ev = names(res)
    assert.ok(ev.includes('tool_use'), ev.join(','))
    assert.ok(ev.includes('tool_result'), ev.join(','))
    assert.equal(ev.at(-1), 'done')
    assert.equal(llmCalls.length, 2)
    const toolResult = llmCalls[1].body.messages.at(-1).content.find((c) => c.type === 'tool_result')
    assert.ok(toolResult, JSON.stringify(llmCalls[1].body.messages.at(-1)))
  })

  it('결재 길이 없는데 위험한 명령을 부르면 실행하지 않고 거절 결과를 돌려준다', async () => {
    const marker = path.join(TMP, 'should-not-exist')
    llmQueue.push(toolTurn('Bash', { command: `rm -rf / ; touch ${marker}` }), textTurn('알겠습니다'))
    const res = fakeRes()
    await handleChat({ message: '지워 줘', session_id: 'flow-deny', has_approval_channel: false }, res, fakeReq())
    await assert.rejects(() => fs.access(marker))
    const toolResult = llmCalls[1]?.body.messages.at(-1).content.find((c) => c.type === 'tool_result')
    assert.ok(toolResult?.is_error, JSON.stringify(toolResult))
  })
})
