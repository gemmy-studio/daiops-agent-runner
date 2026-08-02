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

/**
 * done 이후 buffer를 메모리·디스크에 유지할 시간 (1h).
 *
 * ★**cloud가 15분 넘게 자리를 비운 세션은 resume 대상이 아니다.** 종전 값 24h는
 * "늦게 reconnect해도 replay 가능"을 노린 것이었는데, 그런 reconnect가 도달할 수 있는 경로가 없다:
 *
 * | cloud 상수 | 값 | 의미 |
 * |---|---|---|
 * | `STALE_THINKING_THRESHOLD_MS` | **15분** | 이보다 조용한 세션은 stale reaper가 이미 `failed`로 마킹 |
 * | `FETCH_TIMEOUT_MS` | 12.5분 | cloud가 자리를 비울 수 있는 최대 |
 * | `APPROVAL_TIMEOUT_MS` | 10분 | 결재 대기 상한 |
 *
 * 15분이 천장이므로 그 뒤의 replay는 **이미 죽은 세션**에 대한 것이라 쓸모가 없었다. 24h는 쓸모
 * 있는 창의 96배였고, 그 대가는 처리량에 비례해 쌓이는 메모리·디스크였다.
 *
 * ★그 대가가 실측됐다(daiops ADR 45 §3.19, 2026-07-31 블루 701잡):
 * **메모리 잡당 0.56MB · 디스크 잡당 ~1MB**. 캡 20으로 24시간 지속 포화되면 메모리 7.3GB/8GB ·
 * 디스크 ~13GB/10GB로 **디스크가 먼저 터진다.** 부하가 끝나도 baseline(185MB)으로 돌아오지
 * 않고 456MB에 머무는 것이 이 보존 때문이다.
 *
 * 1h = 15분 천장의 4배 마진. 정상상태 누적이 24배 줄어든다.
 *
 * ⚠️ 이 값을 다시 올리려면 위 세 상수 중 하나가 15분을 넘겨야 한다. 그 전에는 올릴 근거가 없다.
 */
export const RETENTION_AFTER_DONE_MS = 60 * 60 * 1000

/**
 * cloud `STALE_THINKING_THRESHOLD_MS`의 사본 — resume 창의 천장.
 *
 * 여기 두는 이유: 보존시간이 이 값보다 **짧아지면** 살아 있는 세션의 replay가 끊긴다. 그 관계를
 * 테스트로 못 박아 두지 않으면 다음 사람이 보존을 더 줄이다 조용히 넘어선다. cloud가 이 값을
 * 올리면 여기도 올려야 하지만, 그건 15분을 넘기는 설계 변경이라 어차피 이 주석을 읽게 된다.
 */
export const CLOUD_STALE_THINKING_THRESHOLD_MS = 15 * 60 * 1000

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
 * 부팅 1회 — 보존시간을 넘긴 고아 buffer 파일을 지운다.
 *
 * ★**왜 필요한가**: cleanup은 인프로세스 `setTimeout`(`scheduleCleanup`)이다. 러너가 재시작하면
 * 인메모리 buffer는 사라지지만 **`/workspace`의 `.jsonl`은 남고 그것을 지울 타이머도 함께 사라진다.**
 * `forceCleanup`은 `handleResume`의 done-only salvage 경로에서만 불리므로, 재시작 후 cloud가 그 세션을
 * 우연히 resume하지 않으면 그 파일은 **영구 고아**가 된다. 재시작마다 누적된다.
 *
 * 실측 단서(2026-08-02 블루): 러너 재시작으로 메모리는 455MB → 77MB로 떨어졌는데 **디스크는
 * 1,056MB → 1,104MB로 안 떨어졌다.** 보존시간 축소(ADR 45 §3.19)는 *살아 있는* buffer만 줄이므로
 * 이 축은 따로 닫아야 한다.
 *
 * mtime 기준이라 **진행 중 세션은 건드리지 않는다** — 이벤트가 append될 때마다 mtime이 갱신되므로
 * 활성 파일은 항상 최신이다. 살아 있는 replay를 깨지 않는다.
 *
 * 실패는 fail-soft(`ensureBufferDir`과 같은 정책) — 정리 실패가 부팅을 막지 않는다.
 *
 * @returns {Promise<{ deleted: number, scanned: number }>}
 */
export async function sweepOrphanedBuffers() {
  let scanned = 0
  let deleted = 0
  try {
    const entries = await fs.readdir(BUFFER_DIR)
    const cutoff = Date.now() - RETENTION_AFTER_DONE_MS
    for (const name of entries) {
      if (!name.startsWith(FILENAME_PREFIX) || !name.endsWith(FILENAME_SUFFIX)) continue
      scanned++
      const full = path.join(BUFFER_DIR, name)
      try {
        const st = await fs.stat(full)
        if (st.mtimeMs < cutoff) {
          await fs.unlink(full)
          deleted++
        }
      } catch {
        /* 개별 파일 실패는 건너뛴다 — 다음 부팅에 다시 시도된다. */
      }
    }
  } catch (err) {
    // 디렉토리 부재(첫 부팅)는 정상. 그 외 실패도 부팅을 막지 않는다.
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') {
      console.warn(`[event-buffer] sweep 실패: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { deleted, scanned }
  }
  if (deleted > 0) {
    console.log(`[event-buffer] 고아 buffer 파일 ${deleted}개 정리 (스캔 ${scanned}개)`)
  }
  return { deleted, scanned }
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
