/**
 * BashOutput tool — 백그라운드 잡(Bash run_in_background)의 출력·상태 조회.
 *
 * detached 잡은 부모가 waitpid 불가하므로, 상태는 exit sentinel(<id>.exit) 우선 + pid liveness로 판정.
 * 잡 레지스트리 경로는 bash.js resolveJobsDir()를 공유.
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { resolveJobsDir } from './bash.js'

const MAX_OUTPUT_BYTES = 64 * 1024

export const BASH_OUTPUT_TOOL = Object.freeze({
  name: 'BashOutput',
  description: 'Read output and status of a background job started by Bash(run_in_background). Returns the log (tail, up to 64KB) and whether the job is running or exited (with exit code when available).',
  input_schema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'job_id returned by Bash(run_in_background)' },
    },
    required: ['job_id'],
  },
})

/**
 * @param {{job_id: string}} input
 * @returns {Promise<{content: string, is_error?: boolean}>}
 */
export async function runBashOutput(input) {
  const jobId = input?.job_id
  if (!jobId || typeof jobId !== 'string') {
    return { content: 'BashOutput: job_id is required', is_error: true }
  }
  const jobsDir = resolveJobsDir()
  const metaPath = path.join(jobsDir, `${jobId}.meta.json`)
  if (!existsSync(metaPath)) {
    return { content: `BashOutput: job '${jobId}' not found`, is_error: true }
  }
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (err) {
    return { content: `BashOutput: failed to read job meta: ${err.message}`, is_error: true }
  }

  const logPath = meta.log ?? path.join(jobsDir, `${jobId}.log`)
  const exitPath = meta.exit ?? path.join(jobsDir, `${jobId}.exit`)

  let log = ''
  try {
    log = readFileSync(logPath, 'utf8')
  } catch { /* 로그 아직 없음/읽기 실패 — 빈 출력으로 처리 */ }
  let truncated = false
  if (log.length > MAX_OUTPUT_BYTES) {
    log = log.slice(log.length - MAX_OUTPUT_BYTES)
    truncated = true
  }

  // 상태 판정: exit sentinel 우선(정상 종료 시 기록됨), 없으면 pid liveness.
  let status = 'running'
  /** @type {number | null} */
  let exitCode = null
  if (existsSync(exitPath)) {
    status = 'exited'
    try {
      const n = parseInt(readFileSync(exitPath, 'utf8').trim(), 10)
      exitCode = Number.isNaN(n) ? null : n
    } catch { /* exit 파일 읽기 실패 — code unknown */ }
  } else if (typeof meta.pid === 'number') {
    try {
      process.kill(meta.pid, 0) // signal 0 = liveness probe (시그널 미전송)
      status = 'running'
    } catch (err) {
      // ESRCH = 프로세스 없음(sentinel 없이 종료 — SIGKILL/비정상). 그 외(EPERM 등)는 살아있다고 간주.
      status = err.code === 'ESRCH' ? 'exited' : 'running'
    }
  }

  const header = status === 'exited'
    ? `[job ${jobId}] status=exited${exitCode !== null ? ` exit=${exitCode}` : ' (exit code unavailable)'}`
    : `[job ${jobId}] status=running pid=${meta.pid}`
  const truncNote = truncated ? `\n[…output truncated to last ${MAX_OUTPUT_BYTES} bytes]` : ''
  const body = `${header}\n--- output ---\n${log}${truncNote}`.trim()

  // 종료 + 비0 exit code면 is_error (foreground Bash와 일관).
  return {
    content: body,
    ...(status === 'exited' && exitCode !== null && exitCode !== 0 ? { is_error: true } : {}),
  }
}
