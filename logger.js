/**
 * 영속 에러 로거 — 블랙박스(T2).
 *
 * 기존: 모든 console.* 는 nohup stdout 리다이렉트로 /tmp/agent-runner.log 에만 쌓였고,
 * sandbox 재시동 시 통째로 사라졌다(휘발). 또 INFO 노이즈에 에러가 묻혀 triage가 느렸다.
 *
 * 이 모듈은 warn/error 를 persistent volume(/workspace/.agent-runner/logs/errors.log)에
 * *추가로* append 한다 — sandbox 재시동에도 직전 run의 사고 기록이 살아남는다.
 * cloud(claude-sdk-loop)가 sdk_error 수신 시 이 파일을 tail 해 Vercel 로그로 끌어온다.
 *
 * - console.* 는 그대로 호출(메인 로그/stdout 흐름 보존) + errors.log append.
 * - 기동 시 5MB 초과면 .1 로 1회 회전(백업 1개). hermes errors.log(2MB×2) 차용, daiops 보수화.
 * - 파일 쓰기 실패는 조용히 무시(로깅이 본 흐름을 죽이면 안 됨).
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = process.env.AGENT_RUNNER_LOG_DIR || '/workspace/.agent-runner/logs'
const ERRORS_LOG = join(LOG_DIR, 'errors.log')
const MAX_BYTES = 5 * 1024 * 1024 // 5MB

let initialized = false

/** 기동 시 1회: 디렉토리 보장 + 거대해진 errors.log 회전 */
function init() {
  if (initialized) return
  initialized = true
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const size = statSync(ERRORS_LOG).size
    if (size > MAX_BYTES) renameSync(ERRORS_LOG, `${ERRORS_LOG}.1`)
  } catch {
    /* 파일 없음/권한 등은 무시 — 첫 append에서 생성 */
  }
}

function fmt(level, args) {
  const parts = args.map((a) =>
    a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a),
  )
  return `${new Date().toISOString()} [${level}] ${parts.join(' ')}\n`
}

function appendErrorsLog(line) {
  init()
  try {
    appendFileSync(ERRORS_LOG, line)
  } catch {
    /* 쓰기 실패는 무시 */
  }
}

/** info — stdout(메인 로그)만. errors.log 미기록. */
export function logInfo(...args) {
  console.log(...args)
}

/** warn — stdout + errors.log */
export function logWarn(...args) {
  console.warn(...args)
  appendErrorsLog(fmt('WARN', args))
}

/** error — stderr + errors.log */
export function logError(...args) {
  console.error(...args)
  appendErrorsLog(fmt('ERROR', args))
}
