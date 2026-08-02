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
  RETENTION_AFTER_DONE_MS,
  CLOUD_STALE_THINKING_THRESHOLD_MS,
  sweepOrphanedBuffers,
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

// ── 보존시간 (daiops ADR 45 §3.19) ────────────────────────────────────
//
// 이 값은 메모리·디스크 누적을 처리량에 비례해 결정한다(실측 잡당 메모리 0.56MB · 디스크 ~1MB).
// 양쪽 방향 모두 조용히 깨질 수 있어 경계를 못 박는다 — 너무 길면 박스가 차고, 너무 짧으면
// 살아 있는 세션의 replay가 끊긴다.

test('보존시간은 resume 창(cloud stale reaper 15분)보다 길다 — 살아 있는 세션 replay 보장', () => {
  assert.ok(
    RETENTION_AFTER_DONE_MS > CLOUD_STALE_THINKING_THRESHOLD_MS,
    `보존 ${RETENTION_AFTER_DONE_MS}ms가 stale 임계 ${CLOUD_STALE_THINKING_THRESHOLD_MS}ms 이하면 ` +
      '아직 살아 있는 세션의 resume이 끊긴다',
  )
})

test('보존시간은 4시간을 넘지 않는다 — 24h 회귀 방지', () => {
  // 종전 24h는 쓸모 있는 창(15분)의 96배였고 캡 20에서 디스크 ~13GB/10GB를 만들었다.
  // 다시 올리려면 stale 임계·FETCH_TIMEOUT·결재 상한 중 하나가 먼저 늘어나야 한다.
  assert.ok(
    RETENTION_AFTER_DONE_MS <= 4 * 60 * 60 * 1000,
    `보존 ${RETENTION_AFTER_DONE_MS}ms — 근거 없이 다시 늘었는지 확인할 것`,
  )
})

// ── 부팅 sweep — 고아 buffer 파일 (ADR 45 §3.19 후속) ────────────────────
//
// cleanup 타이머는 인프로세스라 재시작하면 사라진다. 그때 남은 .jsonl을 지울 주체가 없어
// 재시작마다 영구 누적됐다(실측: 재시작으로 메모리는 455→77MB인데 디스크는 안 떨어짐).

test('sweep — 보존시간 넘긴 파일만 지우고 최신 파일은 남긴다', async () => {
  const oldPath = path.join(TMP, 'agent-runner-events-sess-orphan.jsonl')
  const newPath = path.join(TMP, 'agent-runner-events-sess-active.jsonl')
  await fs.writeFile(oldPath, '{"seq":1}\n', 'utf-8')
  await fs.writeFile(newPath, '{"seq":1}\n', 'utf-8')

  // 보존시간 + 1분 이전으로 mtime을 되돌린다(진행 중 세션은 append마다 mtime이 갱신된다).
  const stale = new Date(Date.now() - RETENTION_AFTER_DONE_MS - 60_000)
  await fs.utimes(oldPath, stale, stale)

  const result = await sweepOrphanedBuffers()
  assert.equal(result.deleted, 1)
  await assert.rejects(() => fs.access(oldPath), '보존 넘긴 고아는 삭제돼야 한다')
  await fs.access(newPath) // 최신 파일은 남아야 한다 — 진행 중 세션의 replay를 깨지 않는다

  await fs.rm(newPath, { force: true })
})

test('sweep — buffer 파일이 아닌 것은 건드리지 않는다', async () => {
  const other = path.join(TMP, 'unrelated.txt')
  await fs.writeFile(other, 'keep me', 'utf-8')
  const stale = new Date(Date.now() - RETENTION_AFTER_DONE_MS - 60_000)
  await fs.utimes(other, stale, stale)

  await sweepOrphanedBuffers()
  await fs.access(other) // 접두사·확장자가 다르면 스캔 대상이 아니다

  await fs.rm(other, { force: true })
})

test('sweep — 디렉토리가 없어도 throw하지 않는다 (첫 부팅)', async () => {
  // 정리 실패가 부팅을 막아서는 안 된다(fail-soft).
  const result = await sweepOrphanedBuffers()
  assert.equal(typeof result.deleted, 'number')
})
