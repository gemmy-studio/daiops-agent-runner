/**
 * 백그라운드 잡 keepalive.
 *
 * 백그라운드 잡(Bash run_in_background)은 채팅 세션보다 오래 산다. 세션 heartbeat(handler.js)로는
 * 못 덮으므로, 활성 잡이 있는 동안 주기적으로 cloud keepalive를 호출해 sandbox idle auto-stop을 막는다.
 * cloud는 Daytona refreshActivity()로 idle 타이머를 리셋. touch가 멈추면(잡 종료/크래시) 자연 auto-stop
 * = self-healing (setAutostopInterval(0) 영구 비활성과 달리 비용 누수 없음).
 *
 * cloud endpoint: <LLM_PROXY_URL origin>/api/internal/sandbox/keepalive
 * 인증: Bearer AGENT_RUNNER_TOKEN + x-workspace-id (Design B, turn-manager proxy 모드와 동일).
 */

import { promises as fs, openSync, fstatSync, readSync, closeSync, existsSync, constants as fsConstants } from 'node:fs'
import path from 'node:path'

const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000 // 5분 — 기본 idle(15~30분) 대비 충분히 잦음
const MAX_JOB_AGE_MS = 2 * 60 * 60 * 1000 // 2h 상한 — stuck 잡이 sandbox를 영구 유지하지 못하게

let timer = null

/**
 * 백그라운드 잡 레지스트리 디렉토리. event-buffer.js BUFFER_DIR과 같은 persistent volume 베이스.
 * 호출 시점에 env를 읽어 테스트에서 override 가능 (AGENT_RUNNER_JOBS_DIR). Bash, BashOutput, KillShell 이 공유.
 * 종전엔 tools/bash.js 에 있어 bash.js ↔ job-keepalive.js 가 서로를 불러왔다(트랙 G6에서 옮김).
 * @returns {string}
 */
export function resolveJobsDir() {
  return process.env.AGENT_RUNNER_JOBS_DIR ?? '/workspace/.agent-runner/jobs'
}

/**
 * 잡 메타(<id>.meta.json) 폴더. 잡 폴더와 **따로** 둔다(0.41.1, 보안 검토 11-26).
 * 잡 폴더는 감싼 셸이 로그와 종료 코드를 써야 해 쓰기로 열려 있다. 메타가 거기 있으면 감싼 셸이 가짜 메타를 써서
 * 러너가 그 pid 에 신호를 보내거나(KillShell) 그 경로를 대신 읽게(BashOutput) 만들 수 있었다. 기본값은 읽기 전용
 * 러너 상태(`/workspace/.agent-runner/jobs-meta`)라 감싼 셸이 쓰지 못한다. 테스트는 잡 폴더 옆 `<jobs>-meta`.
 * @returns {string}
 */
export function resolveJobsMetaDir() {
  if (process.env.AGENT_RUNNER_JOBS_META_DIR) return process.env.AGENT_RUNNER_JOBS_META_DIR
  return process.env.AGENT_RUNNER_JOBS_DIR ? `${process.env.AGENT_RUNNER_JOBS_DIR}-meta` : '/workspace/.agent-runner/jobs-meta'
}

/** 러너가 만든 job_id 꼴(randomUUID). 경로에 들어가므로 이 꼴만 받는다 */
export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * 잡 폴더 안 파일을 읽는다. 감싼 셸이 이 자리에 심볼릭 링크(예: /proc/self/environ)나 FIFO(읽으면 러너가 멈춤)를
 * 둘 수 있으므로 링크는 따라가지 않고, 막히지 않게 열고, 보통 파일만 읽는다. 아니면 null.
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {string | null}
 */
export function readJobFileSafe(file, maxBytes = Infinity) {
  let fd
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    const size = st.size
    const start = Number.isFinite(maxBytes) && size > maxBytes ? size - maxBytes : 0
    const buf = Buffer.alloc(size - start)
    let off = 0
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off)
      if (n === 0) break
      off += n
    }
    return buf.subarray(0, off).toString('utf8')
  } catch {
    return null
  } finally {
    try { closeSync(fd) } catch { /* 닫힘 */ }
  }
}

/**
 * jobs 디렉토리에 keepalive가 필요한 활성 잡이 있는지.
 * 조건(AND): meta.pid 존재 + exit sentinel 없음 + startedAt 2h 이내 + pid 살아있음.
 * @param {number} [now]
 * @returns {Promise<boolean>}
 */
export async function hasActiveJobs(now = Date.now()) {
  const jobsDir = resolveJobsDir()
  const metaDir = resolveJobsMetaDir()
  let entries
  try {
    entries = await fs.readdir(metaDir)
  } catch {
    return false // 디렉토리 없음 = 잡 없음
  }
  for (const name of entries) {
    if (!name.endsWith('.meta.json')) continue
    const jobId = name.replace(/\.meta\.json$/, '')
    if (!JOB_ID_RE.test(jobId)) continue
    let meta
    try {
      meta = JSON.parse(await fs.readFile(path.join(metaDir, name), 'utf8'))
    } catch {
      continue
    }
    if (typeof meta.pid !== 'number') continue

    // 이미 종료(exit sentinel) → 스킵. 경로는 메타가 아니라 잡 번호로 만든다
    if (existsSync(path.join(jobsDir, `${jobId}.exit`))) continue

    // 2h 상한 초과 → 스킵 (stuck 방지)
    const started = meta.startedAt ? Date.parse(meta.startedAt) : NaN
    if (Number.isFinite(started) && now - started > MAX_JOB_AGE_MS) continue

    // pid liveness
    try {
      process.kill(meta.pid, 0)
    } catch {
      continue // 죽은 프로세스 스킵
    }
    return true // 하나라도 활성이면 keepalive 필요
  }
  return false
}

/**
 * cloud keepalive 1회 호출. LLM_PROXY_URL/토큰/workspace 미설정 시 no-op(로컬/테스트).
 * @param {typeof globalThis.fetch} [fetchFn]
 * @returns {Promise<boolean>} 호출 성공 여부
 */
export async function sendKeepalive(fetchFn = globalThis.fetch) {
  const proxyUrl = process.env.LLM_PROXY_URL
  const token = process.env.AGENT_RUNNER_TOKEN
  const workspaceId = process.env.WORKSPACE_ID
  if (!proxyUrl || !token || !workspaceId) return false

  let url
  try {
    url = new URL('/api/internal/sandbox/keepalive', new URL(proxyUrl).origin).toString()
  } catch {
    return false
  }
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        'x-workspace-id': workspaceId,
      },
      body: '{}',
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * keepalive 인터벌 보장(중복 시작 방지). 첫 백그라운드 잡 시작 시 bash.js가 호출.
 * proxy 미구성(로컬/테스트)이면 시작하지 않음. tick에서 활성 잡이 없으면 인터벌 자기 종료.
 * unref로 프로세스 종료를 막지 않는다.
 * @param {{ intervalMs?: number, fetchFn?: typeof globalThis.fetch }} [opts]
 */
export function ensureJobKeepalive(opts = {}) {
  if (timer) return
  if (!process.env.LLM_PROXY_URL) return // proxy 미구성 = keepalive 대상 아님

  const intervalMs = opts.intervalMs ?? KEEPALIVE_INTERVAL_MS
  const tick = async () => {
    try {
      if (await hasActiveJobs()) {
        await sendKeepalive(opts.fetchFn)
      } else {
        stopJobKeepalive() // 활성 잡 없으면 인터벌 정리
      }
    } catch {
      /* keepalive 실패는 비치명 — 다음 tick 재시도 */
    }
  }
  timer = setInterval(tick, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
}

/** keepalive 인터벌 정리(idempotent). */
export function stopJobKeepalive() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
