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
import { handleChat, resolveApproval, cancelSession, abortAllSessions, isSafeAllowlistPattern } from './handler.js'
import { fetchMaterializedSecrets, startInjectionBroker, writePlaceholderEnvFile } from './proxy/bootstrap.js'
import { EgressObserver } from './proxy/egress-observer.js'
import { MEMORY_EDIT_ACTIONS, isMemoryEditAction, isMemoryEditFailure } from './tools/memory-edit.js'
import { REMEMBER_ACTIONS, isRememberAction, isRememberFailure } from './tools/remember.js'
import { collectRuntimeProbe } from './runtime-probe.js'
import { sweepOrphanedBuffers } from './event-buffer.js'
import { admissionStats } from './tool-cpu-lane.js'
import { initToolCgroup, toolCgroupState } from './tool-cgroup.js'

const PORT = parseInt(process.env.AGENT_RUNNER_PORT ?? '8430', 10)
const HOST = process.env.AGENT_RUNNER_HOST ?? '0.0.0.0'

/**
 * HTTP API contract 버전. CONTRACT.md §2·§4 참조.
 * §2 contract가 깨지는 변경 시에만 +1. agent-runner package version과 별개.
 * 메인 앱은 deploy 직후 /health로 본 값을 검증한다.
 */
const SCHEMA_VERSION = 2

/** package.json에서 자체 version 읽기 (/health 응답용) */
const PACKAGE_VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/**
 * 기동 시 박힌 LLM_PROXY_URL의 origin(scheme+host+port).
 * 메인 앱이 /health 핸드셰이크로 "지금 주입할 값"과 비교해 drift(stale ngrok 등)를 감지하고
 * 불일치면 재시작한다 (CONTRACT.md §2-1). path/토큰은 노출하지 않고 origin만 — /health는
 * 샌드박스 내부(localhost) 전용이라 origin 노출 위험이 낮다. 미설정/파싱 실패 시 null.
 */
/**
 * 부팅 1회 실측한 런타임 자원 스냅샷 (`/health.runtime`).
 * cloud가 티어값과 비교해 `os.cpus()` 오보고를 감지하고, cgroup 쓰기 위임 여부를 판정한다.
 * 부팅 시점 고정값이라 매 요청 재측정하지 않는다 — `memoryCurrent`만 변동하지만 이 필드의 목적은
 * "읽히는가"의 확인이라 스냅샷으로 충분하다(실시간 사용량은 cloud metrics-collector가 담당).
 */
const RUNTIME_PROBE = (() => {
  try {
    return collectRuntimeProbe()
  } catch {
    return null
  }
})()

/**
 * 도구 전용 cgroup 서브그룹 초기화(부팅 1회). 쓰기 위임이 없는 환경에서는 조용히 비활성되고,
 * nice + 메모리 pacing이 그대로 방어를 담당한다. 판정 사유는 `/health.toolCgroup.reason`에 실린다.
 */
initToolCgroup()

const LLM_PROXY_ORIGIN = (() => {
  const raw = process.env.LLM_PROXY_URL
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
})()

/** 인증 토큰 — 필수 환경변수 */
const AUTH_TOKEN = process.env.AGENT_RUNNER_TOKEN
if (!AUTH_TOKEN) {
  console.error('[agent-runner] AGENT_RUNNER_TOKEN 환경변수가 설정되지 않았습니다. 종료합니다.')
  process.exit(1)
}

// ── 크레덴셜 주입 프록시 (Phase 1) — 상시 활성 ─────────────────────────────
// 사용자 설정 시크릿은 placeholder로만 샌드박스에 두고, 프록시가 허용 호스트로 나갈 때만 실값 치환.
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''
const INTEGRATIONS_ENV_PATH = process.env.AGENT_RUNNER_INTEGRATIONS_ENV ?? '/workspace/.integrations.env'

/** @type {Awaited<ReturnType<typeof startInjectionBroker>> | null} */
let injectionBroker = null

/**
 * egress 관측기(A-3 1단계) — 프록시를 지나가는 목적지 호스트를 집계해 cloud에 주기 보고한다.
 * **차단하지 않는다.** 도메인 allowlist(2단계) 프리셋을 추측이 아니라 실측에서 도출하기 위한 수집.
 * 프록시보다 먼저 만들어 둔다(프록시 생성 시 주입).
 * @type {import('./proxy/egress-observer.js').EgressObserver | null}
 */
let egressObserver = null

/**
 * 주입 프록시 (재)초기화: cloud materialize → 프록시 기동/맵 갱신 → placeholder .integrations.env 기록.
 * 진짜 값은 프록시 프로세스 메모리에만. 실패는 fail-open(로그만) — 러너 자체는 계속 동작.
 * 필수 설정(LLM_PROXY_ORIGIN/WORKSPACE_ID/토큰) 누락 시(로컬 dev 등) 프록시 없이 진행.
 * @returns {Promise<{ ok: boolean, count?: number, error?: string }>}
 */
async function initInjectionProxy() {
  if (!LLM_PROXY_ORIGIN || !WORKSPACE_ID || !AUTH_TOKEN) {
    console.warn('[injection-proxy] 필수 설정 누락(LLM_PROXY_ORIGIN/WORKSPACE_ID/토큰) — 프록시 미기동')
    return { ok: false, error: 'missing config' }
  }
  try {
    const secrets = await fetchMaterializedSecrets({
      proxyOrigin: LLM_PROXY_ORIGIN,
      workspaceId: WORKSPACE_ID,
      token: AUTH_TOKEN,
    })
    if (injectionBroker) {
      // 이미 기동됨 → 맵만 교체 + 파일 재작성 (재기동 없이 다음 요청부터 반영)
      const { buildInjectionMap } = await import('./proxy/injection-core.js')
      const normalized = secrets.map((s) => ({ key: s.key, realValue: s.value, allowedHosts: s.allowedHosts ?? [] }))
      const { placeholderByKey, injectionMap } = buildInjectionMap(normalized)
      injectionBroker.injectionMap = injectionMap
      injectionBroker.placeholderByKey = placeholderByKey
      injectionBroker.proxy.updateMap(injectionMap)
      await writePlaceholderEnvFile(INTEGRATIONS_ENV_PATH, placeholderByKey)
      console.log(`[injection-proxy] 갱신 — 시크릿 ${secrets.length}건`)
      return { ok: true, count: secrets.length }
    }
    // egress 관측기는 프록시와 생애를 공유한다(프록시가 유일한 관측 지점).
    if (!egressObserver) {
      egressObserver = new EgressObserver({
        proxyOrigin: LLM_PROXY_ORIGIN,
        workspaceId: WORKSPACE_ID,
        token: AUTH_TOKEN,
        logger: console,
      })
      egressObserver.start()
    }
    injectionBroker = await startInjectionBroker({ secrets, logger: console, observer: egressObserver })
    // 자식 셸이 프록시/CA를 쓰도록 process.env에 설정 (buildToolEnv가 자식 env로만 번역).
    process.env.DAIOPS_INJECTION_PROXY_URL = injectionBroker.proxyUrl
    process.env.DAIOPS_INJECTION_CA_PATH = injectionBroker.caCertPath
    await writePlaceholderEnvFile(INTEGRATIONS_ENV_PATH, injectionBroker.placeholderByKey)
    console.log(`[injection-proxy] 기동 ${injectionBroker.proxyUrl} — 시크릿 ${secrets.length}건`)
    return { ok: true, count: secrets.length }
  } catch (err) {
    console.error('[injection-proxy] 초기화 실패(fail-open):', err instanceof Error ? err.message : err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
  // runtime: 자원 실측 스냅샷(부팅 1회). 필드 추가는 호환 변경이라 schemaVersion 불변 —
  // cloud verifyHealthHandshake는 미지의 필드를 무시한다.
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      version: PACKAGE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      llmProxyOrigin: LLM_PROXY_ORIGIN,
      runtime: RUNTIME_PROBE,
      // admission은 누적 카운터라 매 요청 최신값을 낸다(부팅 스냅샷이 아님).
      admission: (() => {
        try {
          return admissionStats()
        } catch {
          return null
        }
      })(),
      toolCgroup: (() => {
        try {
          return toolCgroupState()
        } catch {
          return null
        }
      })(),
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

  // POST /v1/cancel/:sessionId — 진행 중 세션 즉시 취소 (cloud abort route에서 호출).
  // 세션이 이미 종료돼 activeSessions에 없으면 404(= "취소할 것 없음", cloud는 성공으로 관대 처리).
  if (req.method === 'POST' && url.pathname.startsWith('/v1/cancel/')) {
    const sessionId = decodeURIComponent(url.pathname.slice('/v1/cancel/'.length))
    if (!sessionId) {
      sendJson(res, 400, { error: 'session id required' })
      return
    }
    try {
      const ok = cancelSession(sessionId)
      if (!ok) {
        sendJson(res, 404, { error: 'session not found', session_id: sessionId })
        return
      }
      sendJson(res, 200, { ok: true, session_id: sessionId })
    } catch (err) {
      console.error('[agent-runner] /v1/cancel error', err instanceof Error ? err.stack || err.message : err)
      sendJson(res, 500, { error: 'Internal error' })
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

  // POST /v1/remember/:id — remember_request 해소 (ADR 19). /v1/secret/:id 미러.
  // body: { action: 'saved' | 'duplicate' | 'failed' }. cloud가 updateMemory 수행 후 결과를 통보한다.
  // 같은 approvalRouting/ApprovalManager.resolve 경로 재사용 — decision에 rememberAction을 실어 보낸다.
  if (req.method === 'POST' && url.pathname.startsWith('/v1/remember/')) {
    const rememberId = url.pathname.slice('/v1/remember/'.length)
    if (!rememberId) {
      sendJson(res, 400, { error: 'remember id required' })
      return
    }
    try {
      const raw = await parseBody(req)
      const body = raw ? JSON.parse(raw) : {}
      const action = String(body.action ?? 'saved')
      if (!isRememberAction(action)) {
        sendJson(res, 400, { error: `action must be ${REMEMBER_ACTIONS.join('|')}` })
        return
      }
      // 실패류(failed·blocked) → kind:'deny', 나머지는 allow_once. rememberAction으로 onRemember가 분기.
      const decision = isRememberFailure(action)
        ? { kind: 'deny', rememberAction: action }
        : { kind: 'allow_once', rememberAction: action }
      const resolvedBy = typeof body.resolved_by === 'string' ? body.resolved_by : null
      const ok = resolveApproval(rememberId, decision, resolvedBy)
      if (!ok) {
        sendJson(res, 409, { error: 'remember request already resolved or not found', remember_id: rememberId })
        return
      }
      sendJson(res, 200, { ok: true, remember_id: rememberId })
    } catch (err) {
      console.error('[agent-runner] /v1/remember error', err instanceof Error ? err.stack || err.message : err)
      sendJson(res, 500, { error: 'Internal error' })
    }
    return
  }

  // POST /v1/memory/:id — memory_request(forget·revise) 해소 (ADR 31). /v1/remember/:id 미러.
  // body: { action: 'removed'|'revised'|'protected'|'duplicate'|'not_found'|'failed' }.
  // cloud가 forgetInstruction/reviseInstruction 수행 후 결과를 통보한다. 별도 엔드포인트로 둔 이유:
  // /v1/remember는 action 어휘가 3종으로 고정돼 있고 그 검증을 넓히면 remember 경로의 계약이 흐려진다.
  if (req.method === 'POST' && url.pathname.startsWith('/v1/memory/')) {
    const memoryId = url.pathname.slice('/v1/memory/'.length)
    if (!memoryId) {
      sendJson(res, 400, { error: 'memory id required' })
      return
    }
    try {
      const raw = await parseBody(req)
      const body = raw ? JSON.parse(raw) : {}
      const action = String(body.action ?? 'failed')
      if (!isMemoryEditAction(action)) {
        sendJson(res, 400, { error: `action must be ${MEMORY_EDIT_ACTIONS.join('|')}` })
        return
      }
      // 실패류(failed·not_found)만 deny로 매핑 — 나머지(protected·duplicate 포함)는 "정상 처리됐고
      // 결과가 이것"이라 allow_once다. 문구 분기는 memoryAction으로 onForget/onRevise가 담당한다.
      const decision = isMemoryEditFailure(action)
        ? { kind: 'deny', memoryAction: action }
        : { kind: 'allow_once', memoryAction: action }
      const resolvedBy = typeof body.resolved_by === 'string' ? body.resolved_by : null
      const ok = resolveApproval(memoryId, decision, resolvedBy)
      if (!ok) {
        sendJson(res, 409, { error: 'memory request already resolved or not found', memory_id: memoryId })
        return
      }
      sendJson(res, 200, { ok: true, memory_id: memoryId })
    } catch (err) {
      console.error('[agent-runner] /v1/memory error', err instanceof Error ? err.stack || err.message : err)
      sendJson(res, 500, { error: 'Internal error' })
    }
    return
  }

  // POST /v1/secrets/refresh — cloud가 시크릿 변경 시 호출 → 재-materialize + 프록시 맵/파일 갱신.
  // (syncSecretsToSandbox가 호출. 프록시가 다음 요청부터 새 값/allowed_hosts 반영.)
  if (req.method === 'POST' && url.pathname === '/v1/secrets/refresh') {
    if (!verifyAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const result = await initInjectionProxy()
    sendJson(res, result.ok ? 200 : 500, result)
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

  // 마지막 egress 관측분 보고 — 샌드박스가 자주 꺼지므로 종료 시 flush해야 유실이 적다.
  // 실패해도 종료를 막지 않는다(void + catch).
  if (egressObserver) {
    void egressObserver.stop().catch(() => {})
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
  // 크레덴셜 주입 프록시 상시 부팅. 실패해도 러너는 계속 동작(fail-open).
  initInjectionProxy().catch((err) =>
    console.error('[injection-proxy] 부팅 오류:', err instanceof Error ? err.message : err))
  // 고아 buffer 파일 정리. cleanup 타이머는 인프로세스라 재시작하면 사라지므로, 그때 남은 파일을
  // 지울 주체가 없다 — 부팅 때 한 번 훑는다(근거는 event-buffer.js sweepOrphanedBuffers 주석).
  // listen 뒤에 두는 이유: 정리는 요청 처리와 무관하므로 health 응답을 지연시키지 않는다.
  sweepOrphanedBuffers().catch((err) =>
    console.warn('[event-buffer] sweep 오류:', err instanceof Error ? err.message : err))
})
