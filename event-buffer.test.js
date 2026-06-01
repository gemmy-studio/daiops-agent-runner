/**
 * EventBuffer 단위 테스트.
 * 실행: `node --test agent-runner/event-buffer.test.js`
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP = path.join(os.tmpdir(), `agent-runner-events-test-${Date.now()}`)
process.env.AGENT_RUNNER_BUFFER_DIR = TMP

// 환경변수가 import 시점에 읽히므로 import는 env 설정 후
const {
  appendEvent,
  ensureBuffer,
  getOrCreateBuffer,
  getEventsSince,
  getBufferState,
  forceCleanup,
  listBufferIds,
} = await import('./event-buffer.js')

before(async () => {
  await fs.mkdir(TMP, { recursive: true })
})

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true })
})

test('append 시 seq 단조 증가 + sessionId 보존', () => {
  const sid = 'sess-A'
  const e1 = appendEvent(sid, 'text', { content: 'hi' })
  const e2 = appendEvent(sid, 'tool_use', { name: 'Bash' })
  const e3 = appendEvent(sid, 'text', { content: 'done' })
  assert.equal(e1.seq, 1)
  assert.equal(e2.seq, 2)
  assert.equal(e3.seq, 3)
  assert.equal(e1.sessionId, sid)
})

test('getEventsSince(fromSeq) — fromSeq보다 큰 이벤트만', () => {
  const sid = 'sess-B'
  appendEvent(sid, 'a', {})
  appendEvent(sid, 'b', {})
  appendEvent(sid, 'c', {})
  const since1 = getEventsSince(sid, 1)
  assert.equal(since1.length, 2)
  assert.equal(since1[0].event, 'b')
  assert.equal(since1[1].event, 'c')
  const since3 = getEventsSince(sid, 3)
  assert.equal(since3.length, 0)
})

test('done 이벤트가 buffer.done 플래그를 set', async () => {
  const sid = 'sess-C'
  appendEvent(sid, 'text', { content: 'foo' })
  appendEvent(sid, 'done', { content: 'foo' })
  const state = getBufferState(sid)
  assert.equal(state?.done, true)
  assert.notEqual(state?.doneAtMs, undefined)
})

test('파일에서 buffer 복원 — 메모리에 없으면 ensureBuffer로 jsonl 읽기', async () => {
  const sid = 'sess-D-restore'
  // 메모리에서 만들고 forceCleanup으로 메모리만 비움 (파일은 남김)
  appendEvent(sid, 'text', { content: 'persisted' })
  // 파일이 비동기로 쓰여지니 약간 대기
  await new Promise((r) => setTimeout(r, 50))

  // 메모리에서만 제거 — 파일은 그대로
  const state = getBufferState(sid)
  // 강제로 메모리 비우기 위해 cleanup timer를 흉내내 buffer Map만 삭제
  // (forceCleanup은 파일도 지우므로 사용 안 함 — 대신 state 생성 후 새 sessionId로 ensureBuffer 호출)

  // 새 ensureBuffer 호출 — 파일이 있는 sessionId
  const sid2 = `${sid}-replay`
  // 파일을 sid2 이름으로 복사
  const srcFile = path.join(TMP, `agent-runner-events-${sid}.jsonl`)
  const dstFile = path.join(TMP, `agent-runner-events-${sid2}.jsonl`)
  const data = await fs.readFile(srcFile, 'utf-8')
  await fs.writeFile(dstFile, data, 'utf-8')

  const restored = await ensureBuffer(sid2)
  assert.equal(restored.lastSeq, 1)
  assert.equal(restored.events.length, 1)
  assert.equal(restored.events[0].event, 'text')
})

test('listBufferIds — 활성 buffer 세션 목록', () => {
  const sid = 'sess-E-list'
  appendEvent(sid, 'tick', {})
  const ids = listBufferIds()
  assert.ok(ids.includes(sid))
})

test('forceCleanup — 메모리 + 파일 둘 다 제거', async () => {
  const sid = 'sess-F-cleanup'
  appendEvent(sid, 'tick', {})
  await new Promise((r) => setTimeout(r, 50))
  await forceCleanup(sid)
  assert.equal(getBufferState(sid), null)
  // 파일 fs.access 시 ENOENT
  await assert.rejects(() => fs.access(path.join(TMP, `agent-runner-events-${sid}.jsonl`)))
})

test('getOrCreateBuffer 동기 — 신규 세션은 lastSeq 0으로 생성', () => {
  const sid = 'sess-G-fresh'
  const state = getOrCreateBuffer(sid)
  assert.equal(state.lastSeq, 0)
  assert.equal(state.events.length, 0)
  assert.equal(state.done, false)
})
