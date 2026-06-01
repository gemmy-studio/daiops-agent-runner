/**
 * Bash tool — 쉘 명령 실행. agent-runner sandbox 안에서만 사용 가정.
 *
 *  - workdir 검증 (존재하지 않으면 즉시 에러).
 *  - timeout + abort signal 결합 → SIGTERM 후 잠시 후 SIGKILL.
 *  - stdout/stderr 각 64KB 상한 + truncate 안내.
 *  - exit code 비-0 → is_error.
 *
 * 정책 가드는 cloud canUseTool에서 처리 (rm -rf 같은 위험 명령). 본 도구는 실행만.
 */

import { spawn } from 'node:child_process'
import { existsSync, openSync, closeSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { resolvePath, resolveCwd, buildToolEnv } from './_common.js'
import { ensureJobKeepalive } from '../job-keepalive.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 5 * 60 * 1000
const MAX_OUTPUT_BYTES = 64 * 1024
const SIGKILL_GRACE_MS = 2000

/**
 * 백그라운드 잡 레지스트리 디렉토리. event-buffer.js BUFFER_DIR과 같은 persistent volume 베이스.
 * 호출 시점에 env를 읽어 테스트에서 override 가능 (AGENT_RUNNER_JOBS_DIR). BashOutput/KillShell이 공유.
 * @returns {string}
 */
export function resolveJobsDir() {
  return process.env.AGENT_RUNNER_JOBS_DIR ?? '/workspace/.agent-runner/jobs'
}

export const BASH_TOOL = Object.freeze({
  name: 'Bash',
  description: 'Execute a shell command via /bin/bash -c. Default timeout 30s, max 300s. stdout/stderr captured up to 64KB each.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (max 300000)' },
      run_in_background: { type: 'boolean', description: 'Run detached and return a job_id immediately (no timeout). Use BashOutput to read output and KillShell to stop.' },
      description: { type: 'string', description: '5-10 word summary (optional)' },
    },
    required: ['command'],
  },
})

/**
 * @param {{command: string, timeout?: number, description?: string}} input
 * @param {{ cwd?: string, signal?: AbortSignal, env?: Record<string,string> }} [ctx]
 * @returns {Promise<{content: string, is_error?: boolean}>}
 */
export async function runBash(input, ctx = {}) {
  if (!input || typeof input.command !== 'string' || !input.command) {
    return { content: 'Bash: command is required', is_error: true }
  }
  if (ctx.signal?.aborted) return { content: 'Bash: aborted before start', is_error: true }

  const cwd = resolvePath(resolveCwd(ctx), '/')
  if (!existsSync(cwd)) {
    return { content: `Bash: cwd '${cwd}' does not exist`, is_error: true }
  }

  // 백그라운드: detached spawn 후 즉시 job_id 반환 (timeout/await 미적용).
  if (input.run_in_background === true) {
    return runBackground(input, ctx, cwd)
  }

  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    typeof input.timeout === 'number' && input.timeout > 0 ? input.timeout : DEFAULT_TIMEOUT_MS,
  )

  return await new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', input.command], {
      cwd,
      env: buildToolEnv(ctx.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutBuf = ''
    let stderrBuf = ''
    let stdoutTrunc = false
    let stderrTrunc = false
    let settled = false
    let sigkillTimer = null

    const killProcess = () => {
      try { child.kill('SIGTERM') } catch { /* dead */ }
      sigkillTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* dead */ }
      }, SIGKILL_GRACE_MS)
    }

    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      try { child.kill('SIGTERM') } catch { /* dead */ }
      if (ctx.signal?.removeEventListener) ctx.signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const onAbort = () => {
      killProcess()
      settle({
        content: `Bash: aborted by signal\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`.trim(),
        is_error: true,
      })
    }
    if (ctx.signal) {
      if (ctx.signal.aborted) { settle({ content: 'Bash: aborted', is_error: true }); return }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      killProcess()
      settle({
        content: `Bash: timeout after ${timeoutMs}ms\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`.trim(),
        is_error: true,
      })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (stdoutBuf.length >= MAX_OUTPUT_BYTES) { stdoutTrunc = true; return }
      stdoutBuf += chunk.toString('utf8')
      if (stdoutBuf.length > MAX_OUTPUT_BYTES) {
        stdoutBuf = stdoutBuf.slice(0, MAX_OUTPUT_BYTES)
        stdoutTrunc = true
      }
    })
    child.stderr.on('data', (chunk) => {
      if (stderrBuf.length >= MAX_OUTPUT_BYTES) { stderrTrunc = true; return }
      stderrBuf += chunk.toString('utf8')
      if (stderrBuf.length > MAX_OUTPUT_BYTES) {
        stderrBuf = stderrBuf.slice(0, MAX_OUTPUT_BYTES)
        stderrTrunc = true
      }
    })

    child.on('error', (err) => {
      settle({ content: `Bash: spawn failed: ${err.message}`, is_error: true })
    })

    child.on('close', (code, signal) => {
      const truncNote = (stdoutTrunc || stderrTrunc)
        ? `\n[…output truncated at ${MAX_OUTPUT_BYTES} bytes per stream]`
        : ''
      const status = signal ? `signal=${signal}` : `exit=${code}`
      const stderrSection = stderrBuf ? `\n--- stderr ---\n${stderrBuf}` : ''
      const body = `${stdoutBuf}${stderrSection}${truncNote}\n[${status}]`.trim()
      settle({ content: body, ...(code !== 0 ? { is_error: true } : {}) })
    })
  })
}

/**
 * 백그라운드(detached) 실행 — 즉시 job_id 반환. stdout/stderr는 JOBS_DIR/<id>.log로,
 * 메타는 <id>.meta.json으로 기록. 작업은 agent-runner(persistent sandbox 프로세스)와
 * 독립적으로 계속 돈다. BashOutput(job_id)로 폴링, KillShell(job_id)로 종료.
 *
 * @param {{command: string}} input
 * @param {{ env?: Record<string,string> }} ctx
 * @param {string} cwd
 * @returns {{content: string, is_error?: boolean}}
 */
function runBackground(input, ctx, cwd) {
  const jobsDir = resolveJobsDir()
  try {
    mkdirSync(jobsDir, { recursive: true })
  } catch (err) {
    return { content: `Bash: failed to create jobs dir '${jobsDir}': ${err.message}`, is_error: true }
  }

  const jobId = randomUUID()
  const logPath = path.join(jobsDir, `${jobId}.log`)
  const metaPath = path.join(jobsDir, `${jobId}.meta.json`)
  const exitPath = path.join(jobsDir, `${jobId}.exit`)

  let logFd
  try {
    logFd = openSync(logPath, 'a')
  } catch (err) {
    return { content: `Bash: failed to open job log: ${err.message}`, is_error: true }
  }

  // detached + unref된 잡은 부모가 waitpid로 exit code를 회수할 수 없다. 명령 종료 직후
  // 종료 코드를 sentinel 파일(<id>.exit)에 기록하게 래핑 → BashOutput이 이를 읽어 exitCode 판정.
  // 사용자 명령은 서브셸 ( )로 감싼다 — 명령 안의 exit가 wrapper 셸까지 종료시켜 sentinel 기록을
  // 건너뛰는 것을 막는다. exitPath는 UUID 기반이라 안전하나 공백 대비 single-quote.
  const wrapped = `( ${input.command} )\n__daiops_rc=$?; echo "$__daiops_rc" > '${exitPath}'; exit $__daiops_rc`

  let child
  try {
    child = spawn('/bin/bash', ['-c', wrapped], {
      cwd,
      env: buildToolEnv(ctx.env),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
  } catch (err) {
    try { closeSync(logFd) } catch { /* already closed */ }
    return { content: `Bash: spawn failed: ${err.message}`, is_error: true }
  }
  // 부모는 자체 fd를 닫는다 — 자식이 dup된 fd를 보유.
  try { closeSync(logFd) } catch { /* already closed */ }
  child.unref()

  const meta = {
    job_id: jobId,
    pid: child.pid,
    cmd: input.command,
    cwd,
    startedAt: new Date().toISOString(),
    status: 'running',
    log: logPath,
    exit: exitPath,
  }
  try {
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  } catch { /* 메타 기록 실패는 비치명 — pid 반환은 유효 */ }

  // 활성 잡 동안 sandbox auto-stop 연기. proxy 미구성 시 no-op.
  try { ensureJobKeepalive() } catch { /* keepalive 시작 실패는 잡 실행에 비치명 */ }

  return {
    content: JSON.stringify({ job_id: jobId, pid: child.pid, status: 'running', log: logPath }),
  }
}
