/**
 * Agent Runner MCP Client — Model Context Protocol HTTP transport 자체 구현.
 *
 * 외부 의존성 없이 JSON-RPC 2.0 over HTTP로 MCP 서버와 통신하는 경량 클라이언트.
 *
 * 책임:
 *  1. JSON-RPC 2.0 over HTTP POST로 MCP 서버와 통신 (initialize / tools/list / tools/call).
 *  2. 다중 MCP 서버를 등록해 도구 카탈로그를 집계 + 도구 이름을 `mcp__<server>__<tool>`로 프리픽스.
 *  3. 인증 헤더(Authorization, x-api-key 등)는 outbound 요청에만 포함. 에러 메시지·로그에는 마스킹.
 *  4. MCP tool 결과(`{content: [...], isError}`)를 turn-manager의 tool_result 형식으로 정규화.
 *
 * 비범위 (후속):
 *  - SSE 스트리밍 응답 (서버가 text/event-stream으로 응답하는 long-running tool). 현재는 동기
 *    JSON-RPC 응답만 지원. SSE 응답 시 명확한 에러로 surface.
 *  - stdio transport (별도 자식 프로세스 spawn). HTTP만 지원.
 *  - notifications/* (서버 → 클라이언트 일방향). list_tools/call_tool 흐름에 불필요.
 *
 * MCP 공식 spec: https://modelcontextprotocol.io/docs (HTTP transport / Streamable HTTP)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const MCP_PROTOCOL_VERSION = '2025-06-18'

/** clientInfo.version용 — package.json에서 동적 로드(하드코딩 drift 방지). */
const CLIENT_VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()
/** tools/list pagination 무한루프 가드 — 한 서버에서 합칠 최대 페이지 수. */
const MAX_LIST_PAGES = 20

/**
 * @typedef {Object} McpServerSpec
 * @property {string} name — 서버 식별자 (도구 프리픽스 'mcp__<name>__'에 사용)
 * @property {string} url — JSON-RPC 엔드포인트 URL
 * @property {'http'} [transport] — 현재 'http'만 지원
 * @property {Record<string, string>} [headers] — outbound 헤더 (Authorization 등). 로그 마스킹 대상.
 * @property {boolean} [allowLoopback] — true면 loopback(127.0.0.0/8·localhost·::1) URL을 예외 허용.
 *   샌드박스 로컬 MCP 서버(127.0.0.1:PORT) 도달용. 신뢰된 호출자(cloud)만 설정한다.
 *   메타데이터/내부 엔드포인트는 이 값과 무관하게 항상 차단된다.
 *
 * @typedef {Object} McpToolAnnotations
 * @property {boolean} [readOnlyHint] — 규격 기본값 **false**(= 상태를 바꿀 수 있음). 없으면 없는 대로
 *   보존한다 — 여기서 기본값을 채워 넣지 않는다. "서버가 밝히지 않았다"와 "서버가 false라고 밝혔다"는
 *   게이트 입장에서 결과는 같아도 **로그·결재 사유가 달라야** 하기 때문이다.
 * @property {boolean} [destructiveHint]
 * @property {boolean} [idempotentHint]
 * @property {boolean} [openWorldHint]
 * @property {string} [title]
 *
 * @typedef {Object} McpTool
 * @property {string} name — 원본 도구 이름 (프리픽스 전)
 * @property {string} [description]
 * @property {object} [inputSchema] — JSON Schema (Anthropic input_schema로 변환됨)
 * @property {McpToolAnnotations} [annotations] — MCP 표준 `tools/list` 어노테이션.
 *   **버리지 않는다** — 이것이 외부 서버 도구의 쓰기 여부를 아는 유일한 경로다(QA #105 축1).
 *
 * @typedef {Object} AnthropicToolDef
 * @property {string} name — 프리픽스된 이름 (mcp__<server>__<tool>)
 * @property {string} [description]
 * @property {object} input_schema
 *
 * @typedef {Object} McpToolResult
 * @property {string | Array<{type:'text', text:string}>} content
 * @property {boolean} [is_error]
 *
 * @typedef {{
 *   listTools: () => Promise<McpTool[]>,
 *   callTool: (name: string, args: unknown) => Promise<McpToolResult>,
 *   close: () => Promise<void>,
 *   getServerName: () => string,
 * }} McpClient
 */

/** MCP 표준 `ToolAnnotations` 의 불리언 필드. 규격 밖 키는 싣지 않는다. */
const ANNOTATION_BOOL_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']

/**
 * `tools/list` 어노테이션을 신뢰 가능한 형태로 좁힌다.
 *
 * 서버가 보낸 값을 그대로 들고 다니지 않는 이유: 이 객체는 **결재 판정의 입력**이 되므로,
 * `readOnlyHint: "false"`(문자열)나 `readOnlyHint: 1` 같은 값이 진리값 검사에서 참으로 읽혀
 * 쓰기 도구를 통과시키는 일이 없어야 한다. 불리언이 아닌 값은 **누락으로 취급**한다
 * (= 미선언 → 결재. 규격 기본값과 같은 방향).
 *
 * 하나도 못 건지면 `undefined` — "빈 객체를 받았다"와 "필드가 없다"를 구분할 필요가 없고,
 * 호출부가 `annotations ? … : …` 한 번으로 미선언을 판정할 수 있다.
 *
 * @param {unknown} raw
 * @returns {import('./mcp-client.js').McpToolAnnotations | undefined}
 */
function normalizeAnnotations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of ANNOTATION_BOOL_KEYS) {
    const v = /** @type {Record<string, unknown>} */ (raw)[key]
    if (typeof v === 'boolean') out[key] = v
  }
  const title = /** @type {Record<string, unknown>} */ (raw).title
  if (typeof title === 'string' && title) out.title = title
  return Object.keys(out).length > 0 ? out : undefined
}

/** 인증 헤더로 간주해 로그 직렬화 시 마스킹할 키들. case-insensitive. */
const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
  'set-cookie',
  'proxy-authorization',
])

/** 인증 토큰 안에 포함될 가능성이 높은 패턴 — 에러 메시지·Bash stdout에 우연히 노출됐을 때 마스킹.
 *  값 기반 마스킹(maskSecretValues)이 1차 방어(정확 일치), 이 패턴은 2차(모양 기반 — 값을 몰라도 잡음).
 *  벤더 prefix 목록은 hermes-agent `agent/redact.py` `_PREFIX_PATTERNS`를 이식·보수화.
 *  prefix-anchored라 일반 텍스트 오탐이 낮음(commit SHA·일반 base64는 prefix 불일치로 통과).
 *  ⚠️ 이 마스킹은 심층방어이지 1차 방어가 아니다 — 1차는 애초에 진짜 값을 샌드박스에 안 두는 것
 *  (Phase 1 placeholder 브로커). 짧은 토큰·인코딩 변형은 못 잡는다. */
const TOKEN_VALUE_PATTERNS = [
  // PEM private key 블록 (여러 줄)
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  // Bearer 헤더 값 (base64 padding까지 흡수)
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  // Anthropic / OpenAI (sk-ant-·sk-proj-·sk-admin-은 generic sk- 로 흡수)
  /sk-ant-[A-Za-z0-9_\-+/=]+/g,
  /sk-[A-Za-z0-9_\-+/=]{20,}/g,
  // GitHub (PAT/OAuth/App/refresh + fine-grained pat)
  /gh[posur]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  // GitLab PAT
  /glpat-[A-Za-z0-9_\-]{20,}/g,
  // Slack (bot/user/app/refresh/legacy)
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Stripe 결제 (secret/restricted live·test + webhook signing)
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /whsec_[A-Za-z0-9]{16,}/g,
  // AWS access key id (장기 AKIA / 임시 ASIA)
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  // Google API 키 / OAuth access token
  /AIza[0-9A-Za-z_\-]{35}/g,
  /ya29\.[0-9A-Za-z_\-]+/g,
  // SendGrid
  /SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}/g,
  // npm
  /npm_[A-Za-z0-9]{36}/g,
  // Twilio (Account SID / API Key SID — 32 hex, 하이픈 없어 generic sk- 와 무충돌)
  /(?:AC|SK)[0-9a-fA-F]{32}/g,
  // Notion internal integration token
  /(?:secret_|ntn_)[A-Za-z0-9]{40,}/g,
  // Telegram bot token
  /\d{8,10}:[A-Za-z0-9_-]{35}/g,
  // JWT (eyJ + base64url . base64url . base64url)
  /eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
  // URL 내 자격증명 (scheme://user:pass@host — scheme 앵커로 오탐 방지)
  /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@/gi,
]

/**
 * 로그·에러용 헤더 마스킹 — 민감 키의 값을 `***`로 치환한 *얕은 복사본* 반환.
 * 원본 객체는 변형하지 않음.
 *
 * @param {Record<string, string> | undefined} headers
 */
export function maskSensitiveHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_KEYS.has(k.toLowerCase())) {
      out[k] = '***'
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 임의의 문자열에서 토큰처럼 보이는 패턴을 `***`로 치환. 에러 메시지·서버 응답 본문이
 * 우연히 토큰을 echo한 경우 마지막 가드.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function maskTokensInText(text) {
  let s = typeof text === 'string' ? text : String(text ?? '')
  for (const pat of TOKEN_VALUE_PATTERNS) s = s.replace(pat, '***')
  return s
}

/**
 * 알려진 활성 secret 값들을 텍스트에서 `***`로 치환 (값 기반 — 토큰 모양과 무관하게 정확히 일치).
 * `echo $KEY` / `env` 등으로 Bash stdout에 평문 secret이 흘러나오는 것을 emit 직전에 차단한다.
 *
 * longest-first로 치환해 한 secret이 다른 secret의 부분 문자열일 때 부분 마스킹을 방지하고,
 * 정규식 메타문자를 이스케이프해 값 자체를 리터럴로 매칭한다. (openclaw redact-snapshot.ts
 * collectSensitiveValues + redactRawText 차용 — 길이 floor 없음: 비어있지 않은 값이면 전부 마스킹.)
 *
 * @param {unknown} text
 * @param {Iterable<string>} secretValues — 활성 secret 값 (workspaceSecrets.values())
 * @returns {string}
 */
export function maskSecretValues(text, secretValues) {
  let s = typeof text === 'string' ? text : String(text ?? '')
  if (!s) return s
  const values = [...secretValues]
    .filter((v) => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b.length - a.length)
  for (const v of values) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    s = s.replace(new RegExp(escaped, 'g'), '***')
  }
  return s
}

/**
 * @typedef {Object} McpClientCtx
 * @property {typeof globalThis.fetch} [fetchFn] — 테스트 주입
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs] — 단일 RPC 호출 timeout. 기본 60_000.
 */

/**
 * MCP 서버 URL의 SSRF 가드. MCP 서버는 호출자(cloud)가 설정하므로 내부 호스트가
 * 정당할 수 있어 사설 IP 전체를 막지는 않는다. 대신 가장 위험한 벡터만 차단:
 *  - http/https 외 스킴(file:/ftp:/gopher: 등) 거부
 *  - 클라우드 메타데이터/내부 엔드포인트(IMDS 169.254.*, *.internal, 0.0.0.0, ::) — **항상** 거부
 *  - loopback(127.0.0.0/8, ::1, localhost) 거부 — 단 `opts.allowLoopback`이면 예외 허용
 *
 * loopback 예외는 샌드박스 로컬 MCP 서버(127.0.0.1:PORT) 도달용이며, 신뢰된 호출자(cloud)가
 * spec 단위로 명시 opt-in 했을 때만 열린다. 메타데이터/내부 차단은 opt-in과 무관하게 유지된다.
 * @param {string} rawUrl
 * @param {{ allowLoopback?: boolean }} [opts]
 */
function assertSafeMcpUrl(rawUrl, opts = {}) {
  let u
  try {
    u = new URL(rawUrl)
  } catch {
    throw new Error('createMcpHttpClient: spec.url is not a valid URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`createMcpHttpClient: unsupported URL scheme '${u.protocol}' (http/https only)`)
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  // 메타데이터/내부/wildcard 바인드 — allowLoopback와 무관하게 항상 차단 (SSRF 최우선 벡터).
  const metadataBlocked =
    host.endsWith('.internal') ||
    host === '169.254.169.254' ||
    host.startsWith('169.254.') ||
    host === '0.0.0.0' ||
    host === '::'
  if (metadataBlocked) {
    throw new Error(`createMcpHttpClient: blocked URL host '${u.hostname}' (metadata/internal not allowed)`)
  }

  // loopback — 기본 차단. 신뢰된 호출자가 allowLoopback로 opt-in 했을 때만 허용.
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host)
  if (loopback && !opts.allowLoopback) {
    throw new Error(`createMcpHttpClient: blocked URL host '${u.hostname}' (loopback not allowed)`)
  }
}

/**
 * McpHttpClient 인스턴스 생성. lazy initialize — 첫 호출 시 `initialize` 핸드셰이크.
 *
 * 인증 헤더는 외부에 노출되지 않도록 클로저에 캡쳐된다. getServerName·close는 노출되지만
 * spec.headers는 외부에서 직접 접근할 방법이 없다.
 *
 * @param {McpServerSpec} spec
 * @param {McpClientCtx} [ctx]
 * @returns {McpClient}
 */
export function createMcpHttpClient(spec, ctx = {}) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('createMcpHttpClient: spec is required')
  }
  if (!spec.url || typeof spec.url !== 'string') {
    throw new Error('createMcpHttpClient: spec.url is required')
  }
  if (!spec.name || typeof spec.name !== 'string') {
    throw new Error('createMcpHttpClient: spec.name is required')
  }
  if (spec.transport && spec.transport !== 'http') {
    throw new Error(`createMcpHttpClient: only 'http' transport is supported (got '${spec.transport}')`)
  }
  assertSafeMcpUrl(spec.url, { allowLoopback: spec.allowLoopback === true })

  const fetchFn = ctx.fetchFn ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new Error('createMcpHttpClient: fetch is not available; provide ctx.fetchFn')
  }
  const timeoutMs = ctx.timeoutMs ?? 60_000

  // 호출자 헤더는 클로저에 보관 — 외부에서 접근 불가.
  const headers = { ...(spec.headers ?? {}) }

  let nextId = 1
  /** @type {Promise<void> | null} */
  let initPromise = null
  let closed = false
  // Streamable HTTP 세션 연속성 — initialize 응답의 Mcp-Session-Id를 캡처해 이후 모든 요청에 동봉.
  /** @type {string | null} */
  let sessionId = null

  /**
   * 요청 헤더 빌드 — base + (sessionId 있으면 mcp-session-id) + 호출자 인증 헤더.
   * @param {Record<string,string>} [accept]
   */
  function buildHeaders(accept) {
    return {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...headers,
      ...(accept ?? {}),
    }
  }

  async function rpc(method, params) {
    if (closed) throw new Error(`mcp-client(${spec.name}): closed`)

    const id = nextId++
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })

    // per-call AbortController + 외부 signal과 결합
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    const externalSignal = ctx.signal
    if (externalSignal) {
      if (externalSignal.aborted) ac.abort()
      else externalSignal.addEventListener('abort', onAbort, { once: true })
    }
    const timeoutHandle = setTimeout(() => ac.abort(), timeoutMs)

    // abort 리스너·timeout은 fetch + 응답 본문(SSE 포함) 소비가 끝날 때까지 유지한다.
    // (장시간 SSE 스트림 중에도 external abort가 스트림을 취소할 수 있어야 함.)
    /** @type {{ jsonrpc?: string, id?: number, result?: any, error?: { code: number, message: string, data?: any } }} */
    let payload
    try {
      let res
      try {
        res = await fetchFn(spec.url, {
          method: 'POST',
          headers: buildHeaders(),
          body,
          signal: ac.signal,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`mcp-client(${spec.name}) ${method}: network error: ${maskTokensInText(msg)}`)
      }

      // Streamable HTTP 세션 id 캡처 (initialize 응답에서 부여됨) — 이후 요청에 동봉.
      const sid = res.headers.get('mcp-session-id')
      if (sid) sessionId = sid

      if (!res.ok) {
        const txt = await safeReadText(res)
        throw Object.assign(
          new Error(
            `mcp-client(${spec.name}) ${method}: HTTP ${res.status}: ${maskTokensInText(txt).slice(0, 500)}`,
          ),
          { status: res.status },
        )
      }

      const contentType = String(res.headers.get('content-type') ?? '').toLowerCase()
      if (contentType.includes('text/event-stream')) {
        // Streamable HTTP — 응답이 SSE. data: 라인의 JSON-RPC 메시지 중 이 요청 id에 대응하는 것을 추출.
        payload = await readJsonRpcFromSse(res.body, id, spec.name, method)
      } else {
        try {
          payload = await res.json()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`mcp-client(${spec.name}) ${method}: invalid JSON response: ${maskTokensInText(msg)}`)
        }
      }
    } finally {
      clearTimeout(timeoutHandle)
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort)
    }

    if (payload && payload.error) {
      const e = payload.error
      const errMsg = `mcp-client(${spec.name}) ${method}: JSON-RPC error ${e.code}: ${maskTokensInText(e.message)}`
      throw Object.assign(new Error(errMsg), { code: e.code, data: e.data })
    }

    return payload?.result
  }

  async function ensureInitialized() {
    if (initPromise) return initPromise
    initPromise = (async () => {
      const result = await rpc('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientInfo: { name: 'daiops-agent-runner', version: CLIENT_VERSION },
        capabilities: { tools: {} },
      })
      // notifications/initialized — 일부 서버는 필수. 실패해도 list_tools가 동작하면 무시.
      try {
        const notifyBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
        await fetchFn(spec.url, {
          method: 'POST',
          headers: buildHeaders({ accept: 'application/json' }),
          body: notifyBody,
          signal: ctx.signal,
        }).catch(() => { /* notifications는 best-effort */ })
      } catch { /* ignore */ }
      return result
    })()
    return initPromise
  }

  async function listTools() {
    await ensureInitialized()
    /** @type {McpTool[]} */
    const all = []
    /** @type {string | undefined} */
    let cursor
    // nextCursor pagination — 도구가 많은 서버 대응. 무한루프 가드(최대 페이지 수).
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await rpc('tools/list', cursor ? { cursor } : {})
      const tools = Array.isArray(result?.tools) ? result.tools : []
      for (const t of tools) {
        const name = String(t?.name ?? '')
        if (!name) continue
        const annotations = normalizeAnnotations(t?.annotations)
        all.push({
          name,
          description: typeof t?.description === 'string' ? t.description : undefined,
          inputSchema: t?.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' },
          ...(annotations ? { annotations } : {}),
        })
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
    return all
  }

  async function callTool(toolName, args) {
    await ensureInitialized()
    const result = await rpc('tools/call', { name: toolName, arguments: args ?? {} })
    return normalizeMcpToolResult(result)
  }

  async function close() {
    if (closed) return
    closed = true
    // HTTP transport는 명시적 close가 불필요 — 상태는 클라이언트 측만 보유.
  }

  return {
    listTools,
    callTool,
    close,
    getServerName: () => spec.name,
  }
}

/**
 * MCP tool 결과를 turn-manager의 ToolResult 형식으로 정규화.
 *  - content가 array of {type:'text', text}이면 text만 추출해 join.
 *  - content가 array of {type:'image', ...}면 placeholder text로 변환 (Anthropic은 tool_result에 text만 허용).
 *  - isError → is_error.
 *  - 빈 결과는 '(no output)'.
 *
 * @param {any} raw
 * @returns {McpToolResult}
 */
export function normalizeMcpToolResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return { content: '(no output)' }
  }
  const isError = raw.isError === true
  const blocks = Array.isArray(raw.content) ? raw.content : []
  /** @type {Array<{type:'text', text:string}>} */
  const textBlocks = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') {
      textBlocks.push({ type: 'text', text: b.text })
    } else if (b.type === 'image') {
      const mime = typeof b.mimeType === 'string' ? b.mimeType : 'image'
      textBlocks.push({ type: 'text', text: `[image: ${mime}, omitted]` })
    } else if (typeof b.text === 'string') {
      // type 누락된 경우 fallback
      textBlocks.push({ type: 'text', text: b.text })
    }
  }
  if (textBlocks.length === 0) {
    return { content: '(no output)', ...(isError ? { is_error: true } : {}) }
  }
  // 단일 text 블록은 string으로 평탄화 — Anthropic이 string content도 받음.
  const content = textBlocks.length === 1 ? textBlocks[0].text : textBlocks
  return { content, ...(isError ? { is_error: true } : {}) }
}

/**
 * 다중 MCP 서버를 등록해 도구 카탈로그를 집계 + 호출 라우팅.
 *  - 각 서버의 도구는 `mcp__<server>__<tool>`로 프리픽스되어 Anthropic tools 리스트에 추가됨.
 *  - runTool(prefixedName, args)가 프리픽스를 파싱해 적절한 client.callTool 호출.
 *
 * 사용 패턴:
 *   const registry = await createMcpToolRegistry([{name:'wiki', url:'...'}], { fetchFn })
 *   // registry.tools → Anthropic tools 리스트
 *   // registry.runTool('mcp__wiki__wiki_read', {path:'a'}) → 라우팅
 *   await registry.close()
 *
 * @param {McpServerSpec[]} servers
 * @param {McpClientCtx} [ctx]
 * @returns {Promise<{
 *   tools: AnthropicToolDef[],
 *   runTool: (prefixedName: string, args: unknown, ctx?: { signal?: AbortSignal }) => Promise<McpToolResult>,
 *   close: () => Promise<void>,
 *   getClient: (serverName: string) => McpClient | undefined,
 * }>}
 */
export async function createMcpToolRegistry(servers, ctx = {}) {
  /** @type {Map<string, McpClient>} */
  const clients = new Map()
  /** @type {AnthropicToolDef[]} */
  const tools = []
  /** @type {Map<string, { serverName: string, originalName: string }>} */
  const toolIndex = new Map()

  for (const spec of (servers ?? [])) {
    if (!spec || !spec.name) continue
    if (clients.has(spec.name)) {
      throw new Error(`createMcpToolRegistry: duplicate server name '${spec.name}'`)
    }
    const client = createMcpHttpClient(spec, ctx)
    clients.set(spec.name, client)

    let serverTools = []
    try {
      serverTools = await client.listTools()
    } catch (err) {
      // 1개 서버 실패가 전체를 막지 않도록 — 도구 없이 진행하고 호출자에게 throw하지 않음.
      // (호출자는 도구가 없는 것을 보고 자체 판단). 단, 에러는 stderr로 표면화.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[mcp-client] listTools failed for server '${spec.name}': ${maskTokensInText(msg)}`)
    }

    for (const t of serverTools) {
      const prefixed = `mcp__${spec.name}__${t.name}`
      tools.push({
        name: prefixed,
        ...(t.description ? { description: t.description } : {}),
        input_schema: t.inputSchema ?? { type: 'object' },
      })
      // annotations 는 **모델에게 주는 도구 정의(`tools`)에는 싣지 않고** 색인에만 둔다.
      // 모델이 읽을 이유가 없고(도구 선택 근거가 아니다), 게이트 판정의 입력이므로 모델이
      // 볼수록 "읽기 전용이라고 우기면 통과한다"를 학습시킬 여지만 생긴다.
      toolIndex.set(prefixed, {
        serverName: spec.name,
        originalName: t.name,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })
    }
  }

  async function runTool(prefixedName, args, _callCtx) {
    const entry = toolIndex.get(prefixedName)
    if (!entry) {
      // 프리픽스가 아니거나 등록 안 됨 — caller가 별도로 처리해야 함.
      throw new Error(`mcp-client: tool '${prefixedName}' not found in registry`)
    }
    const client = clients.get(entry.serverName)
    if (!client) throw new Error(`mcp-client: server '${entry.serverName}' not found`)
    return client.callTool(entry.originalName, args)
  }

  async function close() {
    await Promise.allSettled([...clients.values()].map((c) => c.close()))
  }

  /**
   * 프리픽스된 도구 이름 → 출처 서버와 어노테이션. 게이트(canUseTool)가 "이건 외부 서버의
   * 쓰기 도구인가"를 판정하는 데 쓴다. 등록되지 않은 이름이면 `undefined`.
   *
   * @param {string} prefixedName
   * @returns {{ serverName: string, originalName: string, annotations?: import('./mcp-client.js').McpToolAnnotations } | undefined}
   */
  function getToolMeta(prefixedName) {
    return toolIndex.get(prefixedName)
  }

  return {
    tools,
    runTool,
    getToolMeta,
    close,
    getClient: (name) => clients.get(name),
  }
}

/**
 * 도구 이름이 MCP 프리픽스 형식(`mcp__<server>__<tool>`)인지 판별.
 * @param {string} name
 */
export function isMcpToolName(name) {
  return typeof name === 'string' && name.startsWith('mcp__') && name.indexOf('__', 5) > 5
}

/** @param {Response} res */
async function safeReadText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/**
 * SSE 블록(빈 줄로 구분된 한 덩어리)에서 data: 라인을 모아 JSON으로 파싱.
 * MCP Streamable HTTP는 `event:` 없이 `data: {jsonrpc...}`만 보낼 수 있으므로 event 필드는 무시한다.
 * @param {string} block
 * @returns {any | null}
 */
function parseSseDataJson(block) {
  const dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  const text = dataLines.join('')
  if (!text || text === '[DONE]') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Streamable HTTP SSE 응답 body를 읽어, 주어진 JSON-RPC `id`에 대응하는 응답 메시지를 반환.
 * 다른 id의 메시지·notification·진행 이벤트는 건너뛴다. 매칭 메시지를 찾으면 즉시 반환(스트림 조기 종료).
 *
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {number} id — 대응시킬 JSON-RPC 요청 id
 * @param {string} serverName
 * @param {string} method
 * @returns {Promise<{ jsonrpc?: string, id?: number, result?: any, error?: { code: number, message: string, data?: any } }>}
 */
async function readJsonRpcFromSse(body, id, serverName, method) {
  if (!body || typeof body.getReader !== 'function') {
    throw new Error(`mcp-client(${serverName}) ${method}: SSE response had no readable body`)
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  /** @param {string} block */
  const tryMatch = (block) => {
    const msg = parseSseDataJson(block)
    if (msg && msg.id === id && (msg.result !== undefined || msg.error !== undefined)) return msg
    return null
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const matched = tryMatch(block)
        if (matched) return matched
      }
    }
    // 종결자(\n\n) 없이 끝난 마지막 블록 처리
    if (buffer.length > 0) {
      const matched = tryMatch(buffer)
      if (matched) return matched
    }
  } finally {
    // cancel()이 lock 해제까지 처리 — 매칭 후 조기 반환 시 잔여 스트림/연결 정리.
    try { await reader.cancel() } catch { /* best-effort */ }
  }
  throw new Error(`mcp-client(${serverName}) ${method}: SSE stream ended without a response for id ${id}`)
}
