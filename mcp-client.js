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
 *
 * @typedef {Object} McpTool
 * @property {string} name — 원본 도구 이름 (프리픽스 전)
 * @property {string} [description]
 * @property {object} [inputSchema] — JSON Schema (Anthropic input_schema로 변환됨)
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

/** 인증 헤더로 간주해 로그 직렬화 시 마스킹할 키들. case-insensitive. */
const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
  'set-cookie',
  'proxy-authorization',
])

/** 인증 토큰 안에 포함될 가능성이 높은 패턴 — 에러 메시지에 우연히 노출됐을 때 마스킹.
 *  문자 클래스에 base64 변형 문자(`+/=`)도 포함해 sk-ant/Bearer 토큰의 padding까지 흡수.
 *  JWT는 3-segment 구조만 검사 (eyJ + base64url + . + base64url + . + base64url). */
const TOKEN_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /sk-ant-[A-Za-z0-9_\-+/=]+/g,
  /sk-[A-Za-z0-9_\-+/=]{20,}/g,
  /eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, // JWT (3-segment)
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
 *  - 클라우드 메타데이터 엔드포인트(IMDS 169.254.169.254, *.internal) 거부
 *  - loopback(127.0.0.0/8, ::1, localhost) 거부
 * @param {string} rawUrl
 */
function assertSafeMcpUrl(rawUrl) {
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
  const blocked =
    host === 'localhost' ||
    host.endsWith('.internal') ||
    host === '169.254.169.254' ||
    host.startsWith('169.254.') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    /^127\./.test(host)
  if (blocked) {
    throw new Error(`createMcpHttpClient: blocked URL host '${u.hostname}' (loopback/metadata not allowed)`)
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
  assertSafeMcpUrl(spec.url)

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
    /** @type {Array<{name: string, description?: string, inputSchema: object}>} */
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
        all.push({
          name,
          description: typeof t?.description === 'string' ? t.description : undefined,
          inputSchema: t?.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' },
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
      toolIndex.set(prefixed, { serverName: spec.name, originalName: t.name })
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

  return {
    tools,
    runTool,
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
