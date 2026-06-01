/**
 * KillShell tool — 백그라운드 잡(Bash run_in_background) 종료.
 *
 * detached spawn은 새 프로세스 그룹 리더이므로 -pid로 그룹 전체(자식 포함)에 시그널.
 * SIGTERM → grace → SIGKILL. 이미 종료된 잡에도 success(멱등).
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { resolveJobsDir } from './bash.js'

const SIGKILL_GRACE_MS = 2000

export const KILL_SHELL_TOOL = Object.freeze({
  name: 'KillShell',
  description: 'Stop a background job started by Bash(run_in_background) by job_id. Sends SIGTERM, then SIGKILL after a grace period. Idempotent — succeeds if the job already exited.',
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
export async function runKillShell(input) {
  const jobId = input?.job_id
  if (!jobId || typeof jobId !== 'string') {
    return { content: 'KillShell: job_id is required', is_error: true }
  }
  const jobsDir = resolveJobsDir()
  const metaPath = path.join(jobsDir, `${jobId}.meta.json`)
  if (!existsSync(metaPath)) {
    return { content: `KillShell: job '${jobId}' not found`, is_error: true }
  }
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (err) {
    return { content: `KillShell: failed to read job meta: ${err.message}`, is_error: true }
  }
  const pid = meta.pid
  if (typeof pid !== 'number') {
    return { content: `KillShell: job '${jobId}' has no pid`, is_error: true }
  }

  const alive = () => {
    try { process.kill(pid, 0); return true } catch { return false }
  }
  if (!alive()) {
    return { content: `KillShell: job '${jobId}' already exited` }
  }

  // detached = 프로세스 그룹 리더 → -pid로 그룹 전체에 시그널 (자식까지). 실패 시 단일 pid로 폴백.
  const signalGroup = (sig) => {
    try {
      process.kill(-pid, sig)
    } catch {
      try { process.kill(pid, sig) } catch { /* 이미 종료 */ }
    }
  }

  signalGroup('SIGTERM')
  await new Promise((res) => setTimeout(res, SIGKILL_GRACE_MS))
  let escalated = false
  if (alive()) {
    signalGroup('SIGKILL')
    escalated = true
  }

  return { content: `KillShell: stopped job '${jobId}' (pid ${pid}) via SIGTERM${escalated ? '+SIGKILL' : ''}` }
}
