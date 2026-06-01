/**
 * EventBuffer — 세션별 SSE 이벤트 누적 + 파일 백업.
 *
 * 결재 도중 cloud의 Vercel function이 timeout으로 끊겨도 agent-runner는
 * 살아있다. 이벤트는 EventBuffer에 누적되고, T5의 resume_from_seq가
 * cloud reconnect 시 누락분을 replay한다.
 *
 * 영속성 계층:
 *  - in-memory Map (즉시 access)
 *  - /workspace/.agent-runner/buffer/agent-runner-events-{sessionId}.jsonl
 *    (Daytona sandbox persistent volume — sandbox restart에도 생존)
 *  - DB pending_approvals (결재 결과만, T6) — 이벤트는 DB에 안 들어감
 *
 * BUFFER_DIR 기본값: /workspace/.agent-runner/buffer
 * (이전 /tmp는 sandbox restart 시 휘발되어 resume 실패 원인. /workspace는 persistent.)
 * AGENT_RUNNER_BUFFER_DIR 환경변수로 override 가능 (테스트는 /tmp 사용).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const BUFFER_DIR = process.env.AGENT_RUNNER_BUFFER_DIR ?? '/workspace/.agent-runner/buffer'
const FILENAME_PREFIX = 'agent-runner-events-'
const FILENAME_SUFFIX = '.jsonl'

/** BUFFER_DIR 디렉토리 보장 — 첫 파일 I/O 직전 1회 실행. */
let bufferDirEnsured = false
async function ensureBufferDir() {
  if (bufferDirEnsured) return
  try {
    await fs.mkdir(BUFFER_DIR, { recursive: true })
    bufferDirEnsured = true
  } catch (err) {
    // mkdir 실패도 fatal 아님 — appendToFile/readFile catch에서 처리.
    console.warn(`[event-buffer] mkdir 실패 ${BUFFER_DIR}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** done 이후 buffer를 메모리에 유지할 시간 (24h). cloud가 늦게 reconnect해도 replay 가능. */
const RETENTION_AFTER_DONE_MS = 24 * 60 * 60 * 1000

/**
 * @typedef {object} BufferedEvent
 * @property {number} seq
 * @property {string} sessionId
 * @property {string} event
 * @property {Record<string, unknown>} data
 * @property {number} ts
 */

/**
 * @typedef {object} BufferState
 * @property {string} sessionId
 * @property {BufferedEvent[]} events
 * @property {number} lastSeq
 * @property {boolean} done
 * @property {number} createdAtMs
 * @property {number} [doneAtMs]
 * @property {ReturnType<typeof setTimeout>} [cleanupTimer]
 */

/** @type {Map<string, BufferState>} */
const buffers = new Map()

function bufferPath(sessionId) {
  return path.join(BUFFER_DIR, `${FILENAME_PREFIX}${sessionId}${FILENAME_SUFFIX}`)
}

async function appendToFile(sessionId, evt) {
  await ensureBufferDir()
  try {
    await fs.appendFile(bufferPath(sessionId), JSON.stringify(evt) + '\n', 'utf-8')
  } catch (err) {
    // 파일 쓰기 실패는 fatal 아님 — 메모리 buffer는 유지.
    console.warn(`[event-buffer] append 실패 ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function deleteFile(sessionId) {
  try {
    await fs.unlink(bufferPath(sessionId))
  } catch {
    /* ignore */
  }
}

/**
 * 세션 buffer를 보장(없으면 생성). 기존 파일이 있으면 복원.
 *
 * @param {string} sessionId
 * @returns {Promise<BufferState>}
 */
export async function ensureBuffer(sessionId) {
  const existing = buffers.get(sessionId)
  if (existing) return existing

  /** @type {BufferState} */
  const state = {
    sessionId,
    events: [],
    lastSeq: 0,
    done: false,
    createdAtMs: Date.now(),
  }

  // 파일 복원 (best-effort)
  await ensureBufferDir()
  try {
    const raw = await fs.readFile(bufferPath(sessionId), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    for (const line of lines) {
      try {
        const evt = JSON.parse(line)
        if (typeof evt?.seq === 'number') {
          state.events.push(evt)
          if (evt.seq > state.lastSeq) state.lastSeq = evt.seq
          if (evt.event === 'done') {
            state.done = true
            state.doneAtMs = evt.ts
          }
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* 파일 부재는 정상 (신규 세션) */
  }

  buffers.set(sessionId, state)
  return state
}

/**
 * 동기 버전 — 파일 복원 없이 메모리 buffer만 보장. 신규 세션 핫패스용.
 *
 * @param {string} sessionId
 * @returns {BufferState}
 */
export function getOrCreateBuffer(sessionId) {
  let state = buffers.get(sessionId)
  if (state) return state
  state = {
    sessionId,
    events: [],
    lastSeq: 0,
    done: false,
    createdAtMs: Date.now(),
  }
  buffers.set(sessionId, state)
  return state
}

/**
 * 이벤트 append + 파일 백업. seq를 자동 할당.
 *
 * @param {string} sessionId
 * @param {string} event
 * @param {Record<string, unknown>} data
 * @returns {BufferedEvent}
 */
export function appendEvent(sessionId, event, data) {
  const state = getOrCreateBuffer(sessionId)
  state.lastSeq += 1
  /** @type {BufferedEvent} */
  const evt = {
    seq: state.lastSeq,
    sessionId,
    event,
    data,
    ts: Date.now(),
  }
  state.events.push(evt)
  if (event === 'done') {
    state.done = true
    state.doneAtMs = evt.ts
    scheduleCleanup(state)
  }
  // 비동기 파일 append (fire-and-forget). 메모리 buffer가 1차 진실 소스.
  appendToFile(sessionId, evt)
  return evt
}

/**
 * from_seq 이후 이벤트만 반환. T5 resume에서 사용.
 *
 * @param {string} sessionId
 * @param {number} fromSeq - 이 seq보다 큰 이벤트만 반환 (>=로 잘 안 매칭하기 위해)
 * @returns {BufferedEvent[]}
 */
export function getEventsSince(sessionId, fromSeq) {
  const state = buffers.get(sessionId)
  if (!state) return []
  return state.events.filter((e) => e.seq > fromSeq)
}

/**
 * @param {string} sessionId
 * @returns {BufferState | null}
 */
export function getBufferState(sessionId) {
  return buffers.get(sessionId) ?? null
}

function scheduleCleanup(state) {
  if (state.cleanupTimer) clearTimeout(state.cleanupTimer)
  state.cleanupTimer = setTimeout(() => {
    buffers.delete(state.sessionId)
    deleteFile(state.sessionId)
  }, RETENTION_AFTER_DONE_MS)
  // unref → cleanup 타이머가 프로세스 종료를 막지 않게.
  state.cleanupTimer.unref?.()
}

/**
 * 운영용 — 강제 cleanup. 테스트나 수동 정리 시.
 *
 * @param {string} sessionId
 */
export async function forceCleanup(sessionId) {
  const state = buffers.get(sessionId)
  if (state?.cleanupTimer) clearTimeout(state.cleanupTimer)
  buffers.delete(sessionId)
  await deleteFile(sessionId)
}

/** 운영용 — 모든 buffer state 스냅샷. T9 sandbox 보호 판정에서 활성 세션 카운트로 사용. */
export function listBufferIds() {
  return Array.from(buffers.keys())
}
