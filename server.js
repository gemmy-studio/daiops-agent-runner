/**
 * Agent Runner — 샌드박스 내 경량 HTTP 서버.
 * turn-manager를 통해 Anthropic Messages API를 직접 호출하고 SSE로 스트리밍한다
 * (@anthropic-ai/claude-agent-sdk 의존 없이 Anthropic Messages API raw HTTP 직접 호출).
 * Daytona 샌드박스 내에서 독립 실행됩니다.
 *
 * 순수 JS(ESM) — 컴파일 없이 node server.js로 실행 가능.
 */

import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { handleChat, resolveApproval, abortAllSessions, isSafeAllowlistPattern } from './handler.js'

const PORT = parseInt(process.env.AGENT_RUNNER_PORT ?? '8430', 10)
const HOST = process.env.AGENT_RUNNER_HOST ?? '0.0.0.0'

/**
 * HTTP API contract 버전. CONTRACT.md §2·§4 참조.
 * §2 contract가 깨지는 변경 시에만 +1. agent-runner package version과 별개.
 * 메인 앱은 deploy 직후 /health로 본 값을 검증한다.
 */
const SCHEMA_VERSION = 1

/** package.json에서 자체 version 읽기 (/health 응답용) */
const PACKAGE_VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** 인증 토큰 — 필수 환경변수 */
const AUTH_TOKEN = process.env.AGENT_RUNNER_TOKEN
if (!AUTH_TOKEN) {
  console.error('[agent-runner] AGENT_RUNNER_TOKEN 환경변수가 설정되지 않았습니다. 종료합니다.')
  process.exit(1)
}

/** @param {import('node:http').IncomingMessage} req */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 */
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/** Bearer 토큰 검증 — 상수 시간 비교(timingSafeEqual)로 타이밍 사이드채널 차단 */
function verifyAuth(req) {
  const authHeader = req.headers.authorization ?? ''
  const expected = `Bearer ${AUTH_TOKEN}`
  // 길이가 다르면 timingSafeEqual이 throw하므로 먼저 거른다(길이 노출은 무의미).
  const a = Buffer.from(authHeader)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  // CORS 헤더 — 샌드박스 내부 통신이므로 localhost만 허용
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // GET /health — 헬스체크 (인증 불필요).
  // version·schemaVersion 노출 — 메인 앱이 deploy 직후 핸드셰이크로 호환성 검증 (CONTRACT.md §2-1).
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      version: PACKAGE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      timestamp: Date.now(),
    })
    return
  }

  // 인증 검증
  if (!verifyAuth(req)) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }

  // POST /v1/chat — turn-manager 멀티턴 루프 호출 + SSE 스트리밍
  if (req.method === 'POST' && url.pathname === '/v1/chat') {
    try {
      const body = await parseBody(req)
      const params = JSON.parse(body)
      await handleChat(params, res, req)
    } catch (err) {
      // 원문 에러는 서버 로그로만 — 응답 본문에 상세를 노출하지 않는다.
      console.error('[agent-runner] /v1/chat error', err instanceof Error ? err.stack || err.message : err)
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal error' })
      }
    }
    return
  }

  // POST /v1/approval/:id — 결재 결과 주입 (T3).
  // 활성 세션의 ApprovalManager.resolve로 라우팅 → canUseTool await가 풀림.
  if (req.method === 'POST' && url.pathname.startsWith('/v1/approval/')) {
    const approvalId = url.pathname.slice('/v1/approval/'.length)
    if (!approvalId) {
      sendJson(res, 400, { error: 'approval id required' })
      return
    }
    try {
      const raw = await parseBody(req)
      const body = raw ? JSON.parse(raw) : {}
      const kind = String(body.decision ?? body.kind ?? '')
      if (!['allow_once', 'allow_always', 'deny'].includes(kind)) {
        sendJson(res, 400, { error: 'decision must be one of allow_once|allow_always|deny' })
        return
      }
      // SEC-T3: 네트워크로 받은 allowlist_entry를 재검증(charset·인터프리터 deny). 안전하지 않으면
      // 무시 → sticky 없이 일회성 allow로 처리(방어심화, cloud 파생 검증과 이중화).
      const rawEntry = typeof body.allowlist_entry === 'string' ? body.allowlist_entry : undefined
      const allowlistEntry = rawEntry && isSafeAllowlistPattern(rawEntry) ? rawEntry : undefined
      const decision = {
        kind,
        allowlistEntry,
        feedback: typeof body.feedback === 'string' ? body.feedback : undefined,
      }
      const resolvedBy = typeof body.resolved_by === 'string' ? body.resolved_by : null
      const ok = resolveApproval(approvalId, decision, resolvedBy)
      if (!ok) {
        // 멱등 — 이미 resolved되었거나 알 수 없는 id (canUseTool 외 경로 또는 timeout 경유)
        sendJson(res, 409, { error: 'approval already resolved or not found', approval_id: approvalId })
        return
      }
      sendJson(res, 200, { ok: true, approval_id: approvalId })
    } catch (err) {
      console.error('[agent-runner] /v1/approval error', err instanceof Error ? err.stack || err.message : err)
      sendJson(res, 500, { error: 'Internal error' })
    }
    return
  }

  // POST /v1/secret/:id — secret_request 해소 (Phase B). /v1/approval/:id 미러.
  // body: { action: 'provide', value: '<평문>' } 또는 { action: 'skip' }.
  // 같은 approvalRouting/ApprovalManager.resolve 경로 재사용 — decision에 secretAction/value를 실어 보낸다.
  // 값(평문)은 cloud→agent-runner(sandbox preview URL, bearer+preview token, HTTPS) 경계에서만 흐른다.
  if (req.method === 'POST' && url.pathname.startsWith('/v1/secret/')) {
    const secretId = url.pathname.slice('/v1/secret/'.length)
    if (!secretId) {
      sendJson(res, 400, { error: 'secret id required' })
      return
    }
    try {
      const raw = await parseBody(req)
      const body = raw ? JSON.parse(raw) : {}
      const action = String(body.action ?? (typeof body.value === 'string' ? 'provide' : ''))
      if (action !== 'provide' && action !== 'skip') {
        sendJson(res, 400, { error: 'action must be provide|skip' })
        return
      }
      let decision
      if (action === 'skip') {
        // 건너뛰기 — kind:'deny'로 매핑하되 secretAction으로 의도를 구분(onRequestSecret이 분기).
        decision = { kind: 'deny', secretAction: 'skip' }
      } else {
        const value = typeof body.value === 'string' ? body.value : ''
        if (!value) {
          sendJson(res, 400, { error: 'value required when action=provide' })
          return
        }
        decision = { kind: 'allow_once', secretAction: 'provide', value }
      }
      const resolvedBy = typeof body.resolved_by === 'string' ? body.resolved_by : null
      const ok = resolveApproval(secretId, decision, resolvedBy)
      if (!ok) {
        sendJson(res, 409, { error: 'secret request already resolved or not found', secret_id: secretId })
        return
      }
      sendJson(res, 200, { ok: true, secret_id: secretId })
    } catch (err) {
      // 평문 value가 본문에 있을 수 있으므로 에러 메시지를 응답에 노출하지 않는다 (서버 로그만).
      console.error('[agent-runner] /v1/secret error', err instanceof Error ? err.stack || err.message : err)
      sendJson(res, 500, { error: 'Internal error' })
    }
    return
  }

  sendJson(res, 404, { error: 'Not found' })
})

// Graceful shutdown
let isShuttingDown = false

function gracefulShutdown(signal) {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[agent-runner] ${signal} 수신, graceful shutdown 시작...`)

  // in-flight turn-manager 루프를 먼저 abort — abort 신호가 SSE fetch/도구 실행을 취소해
  // cleanup이 server.close()와 동시에 진행, SIGKILL 전에 끝날 가능성을 높인다.
  const aborted = abortAllSessions()
  if (aborted > 0) {
    console.log(`[agent-runner] in-flight 세션 ${aborted}건 abort 신호 송신`)
  }

  server.close(() => {
    console.log('[agent-runner] 서버 종료 완료')
    process.exit(0)
  })

  // 10초 내 종료 안 되면 강제 종료
  setTimeout(() => {
    console.error('[agent-runner] graceful shutdown 타임아웃, 강제 종료')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// 예기치 않은 에러 핸들링
process.on('uncaughtException', (err) => {
  console.error('[agent-runner] uncaughtException:', err.message)
  gracefulShutdown('uncaughtException')
})

process.on('unhandledRejection', (reason) => {
  console.error('[agent-runner] unhandledRejection:', reason)
})

server.listen(PORT, HOST, () => {
  console.log(`[agent-runner] listening on ${HOST}:${PORT}`)
})
