/**
 * KillShell tool — 백그라운드 잡(Bash run_in_background) 종료.
 *
 * detached spawn은 새 프로세스 그룹 리더이므로 -pid로 그룹 전체(자식 포함)에 시그널.
 * SIGTERM → grace → SIGKILL. 이미 종료된 잡에도 success(멱등).
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { resolveJobsMetaDir, JOB_ID_RE } from '../job-keepalive.js'

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
  if (!JOB_ID_RE.test(jobId)) {
    return { content: `KillShell: job '${jobId}' not found`, is_error: true }
  }
  const metaPath = path.join(resolveJobsMetaDir(), `${jobId}.meta.json`)
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
  const refusal = killTargetRefusal(pid)
  if (refusal) {
    return { content: `KillShell: refusing to signal pid ${pid} (${refusal})`, is_error: true }
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

/**
 * 신호를 보내면 안 되는 대상이면 사유, 아니면 null. 메타는 러너만 쓰는 폴더에 있지만(0.41.1) 옛 판 메타, 번호 재사용에
 * 대비해 한 번 더 본다: 0, 1, 음수(kill(0)=러너 자기 그룹, kill(-1)=전부), 러너 자신, 러너와 같은 프로세스 그룹.
 * 잡은 detached 로 떠 자기 그룹의 리더라 러너 그룹과 같을 수 없다.
 * @param {number} pid
 * @param {{ selfPid?: number, groupOf?: (pid: number | 'self') => number | null }} [deps]
 * @returns {string | null}
 */
export function killTargetRefusal(pid, { selfPid = process.pid, groupOf = processGroupOf } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return 'not a job pid'
  if (pid === selfPid) return 'runner itself'
  const own = groupOf('self')
  const target = groupOf(pid)
  if (own !== null && target !== null && own === target) return 'runner process group'
  return null
}

/** /proc/<pid>/stat 의 5번째 칸(pgrp). /proc 가 없으면(macOS 등) null */
function processGroupOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // 2번째 칸(comm)은 괄호 안에 공백이 들어갈 수 있어 마지막 ')' 뒤부터 센다
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const pgrp = Number(rest[2])
    return Number.isInteger(pgrp) ? pgrp : null
  } catch {
    return null
  }
}
