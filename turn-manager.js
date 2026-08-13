/**
 * Agent Runner Turn Manager — Anthropic Messages API raw HTTP + SSE 자체 파싱 + multi-turn loop.
 *
 * Anthropic Messages API를 raw HTTP로 직접 호출하고 multi-turn tool 루프를 자체 운영한다.
 *
 * 책임:
 *  1. raw HTTP fetch로 /v1/messages 호출 (stream:true), SSE 이벤트를 자체 파싱.
 *  2. content blocks(text·tool_use)를 누적해 완성된 assistant message 합성.
 *  3. SDK의 SDKMessage shape(message.type=assistant|user|result)와 1:1로 정규화 yield —
 *     기존 sdkMessageToLLMEvents 변환이 그대로 동작.
 *  4. multi-turn loop을 직접 운영. tool_use 감지 시 canUseTool await(allow/deny) →
 *     allow면 runTool 실행 → tool_result blocks를 user 메시지로 합성해 다음 turn push.
 *  5. AbortController.signal 전파 — chunk 사이·turn 사이에서 즉시 break.
 *  6. 정규화 layer:
 *     - 모델 ID → max_tokens 자동 산출 (ANTHROPIC_OUTPUT_LIMITS).
 *     - 4.6/4.7 세대에서 adaptive thinking 자동 활성화 + xhigh 세대 분기.
 *     - system_and_3 전략으로 prompt cache_control 자동 삽입 (system + 마지막 3개 non-system).
 *     - 4.7+에서 temperature/top_p/top_k 자동 제거.
 *
 * MCP 통합 (3.3): input.options.mcpServers가 있으면 mcp-client.js로 registry 자동 생성,
 *                 tools를 anthropic 요청에 머지, `mcp__<server>__<tool>` 프리픽스로 runTool 라우팅.
 */

import { createMcpToolRegistry, isMcpToolName } from './mcp-client.js'
import { withJitteredRetry } from './retry-utils.js'
import { enforceTurnResultBudget, evictImagesForBudget } from './offload.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 스트림 stale 감지 임계 (ms) — 업스트림(Anthropic / cloud LLM proxy)이 연결은 살아있는데
 * *바이트를 보내지 않는* 상태를 감지하는 idle 타임아웃. chunk 도착마다 리셋되며, 이 시간 안에
 * 다음 chunk가 오지 않으면 stale로 판단해 요청을 끊고 retryable timeout으로 surface한다.
 *
 * 배경: agent-runner에는 시간 기반 abort가 없어, 업스트림이 토큰 생성 도중 멈추면(연결만 유지)
 * cloud의 FETCH_TIMEOUT(750s)까지 그대로 매달려 사용자에게 "멈춤"으로 보인다. hermes
 * (run_agent.py last_chunk_time 감시 → HTTP 클라이언트 교체) 패턴의 daiops 이식.
 *
 * Anthropic은 스트림 유지 중 `ping` SSE 이벤트를 주기적으로 보내고, adaptive thinking 중에도
 * thinking_delta chunk가 흐르므로, 정상 장기 추론은 idle로 오인되지 않는다. 따라서 임계는
 * "정상 ping 간격 ≫" 수준으로 넉넉히 둔다. env로 override 가능(테스트·튜닝).
 */
export const STREAM_STALE_TIMEOUT_MS = (() => {
  const v = Number(process.env.AGENT_RUNNER_STREAM_STALE_MS)
  return Number.isFinite(v) && v > 0 ? v : 120_000
})()

/**
 * connect/헤더 수신 타임아웃 (ms) — fetch가 응답 헤더를 받기 전(connect·TLS·TTFB) 단계의 hang 방어.
 * streamWithStaleGuard(STREAM_STALE_TIMEOUT_MS)는 res.body가 생긴 *이후* chunk-idle만 감시하므로,
 * 헤더 수신 전 단계는 무방비였다(undici 기본 headersTimeout ~300s에만 의존 → 사용자 체감 "멈춤").
 * res(헤더) 도착 즉시 해제되므로 스트리밍 body에는 영향이 없다. hermes httpx.Timeout(connect=10) 대응이되,
 * Anthropic/LLM 프록시의 TTFB 여유를 감안해 넉넉히 잡는다. env로 override 가능(테스트·튜닝).
 */
export const CONNECT_HEADERS_TIMEOUT_MS = (() => {
  const v = Number(process.env.AGENT_RUNNER_CONNECT_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 30_000
})()

/** stale watchdog이 read race를 끊을 때 던지는 내부 sentinel. */
const STREAM_STALE = Symbol('stream-stale')

// ── 컨텍스트 압축 (REF-1 A2-②) ────────────────────────────────────────────
// hermes context_compressor._prune_old_tool_results 차용 — LLM 없는 cheap pre-pass.
// 직전 turn input_tokens가 임계를 넘으면, 보호 tail 밖의 오래된 tool_result 내용을 1줄
// 요약으로 치환해 멀티턴 토큰 선형 증가(캐시 미스 폭증)를 완화한다. 임계 미만이면 prefix
// 캐시 보존을 위해 건드리지 않음(hermes should_compress 0.5 임계 + anti-thrashing 정신).
/** 직전 turn input_tokens가 이 값을 넘으면 프루닝 트리거 (Opus 200K window의 절반 수준). */
const PRUNE_THRESHOLD_TOKENS = (() => {
  const v = Number(process.env.AGENT_RUNNER_PRUNE_THRESHOLD_TOKENS)
  return Number.isFinite(v) && v > 0 ? v : 100_000
})()
/** 최근 N개 메시지는 프루닝하지 않음(하드 최소 플로어). assistant+user 페어 ≈ 3턴. */
const PRUNE_PROTECT_TAIL = 6
/**
 * protect-tail을 "개수"가 아니라 "최근 tool_result char 예산"으로 정의한다(우선순위4).
 * 최근 결과가 이 예산 이내이면 그 앞의 오래된 tool_result만 프루닝 — 큰 결과가 최근 6개 안에
 * 몰려도 개수 보호에 걸려 못 줄이던 갭을 해소. opencode PRUNE_PROTECT(40k tokens) × 4(chars/token) 차용.
 */
const PRUNE_PROTECT_TAIL_CHARS = (() => {
  const v = Number(process.env.AGENT_RUNNER_PRUNE_PROTECT_TAIL_CHARS)
  return Number.isFinite(v) && v > 0 ? v : 160_000
})()
/** char↔token 대략 환산(hermes _CHARS_PER_TOKEN=4). 프리엠티브 추정 전용. */
const CHARS_PER_TOKEN = 4

/**
 * 발신 전 요청 body byte 상한. LLM 프록시(Vercel 함수)의 요청 body 한도(~4.5MB, 엣지가 함수 실행 전
 * FUNCTION_PAYLOAD_TOO_LARGE로 반려)보다 낮게 잡아 사전에 축소·차단한다. char 예산·token 추정이 못 잡는
 * base64 이미지 누적까지 "실제 직렬화 byte"라는 단일 진실 지표로 방어(opencode Buffer.byteLength 차용).
 */
const REQUEST_BYTE_BUDGET = (() => {
  const v = Number(process.env.AGENT_RUNNER_REQUEST_BYTE_BUDGET)
  return Number.isFinite(v) && v > 0 ? v : 4_000_000
})()
/** 이 길이 이하 tool_result는 요약 이득이 없어 건너뜀. */
const PRUNE_MIN_CHARS = 200
/** 이미 프루닝된 결과를 식별하는 마커(재프루닝 무한 방지 = 멱등). */
const PRUNED_MARKER = '…[이전 도구 결과 생략]'

// ── 구조화 출력 최종턴 전환 (AGENT-API-5) ──────────────────────────────────
/**
 * final_turn 모드에서 open phase(도구 자유 사용)가 자연 종료(end_turn)한 뒤, 모델에 구조화 제출을
 * 지시하는 user 메시지. 이 메시지 다음 turn은 tool_choice로 submit_structured_response를 강제한다.
 */
const STRUCTURED_FINALIZE_PROMPT =
  '이제 지금까지의 결과를 submit_structured_response 도구로 제출하세요. ' +
  '요구된 JSON 스키마에 정확히 부합하도록 호출해야 하며, 자유 텍스트로 답하지 마세요.'

/** tool_result.content(string | [{type:'text',text}])를 평문으로. */
function toolResultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
  }
  return ''
}

/** 한 메시지가 담은 tool_result의 평문 char 합. user 메시지가 아니면 0. */
function messageToolResultChars(m) {
  if (!m || m.role !== 'user' || !Array.isArray(m.content)) return 0
  let n = 0
  for (const b of m.content) {
    if (b && b.type === 'tool_result') n += toolResultText(b.content).length
  }
  return n
}

/** messages 전체의 tool_result char 합(프리엠티브 트리거 추정용). */
export function estimateMessagesToolResultChars(messages) {
  if (!Array.isArray(messages)) return 0
  let n = 0
  for (const m of messages) n += messageToolResultChars(m)
  return n
}

/** 절대 프루닝하지 않는 최근 메시지 수(하드 플로어). 직전 도구 결과는 추론에 필수 → 항상 보존. */
const PRUNE_HARD_MIN_TAIL = 2

/**
 * 프루닝 boundary(0..boundary-1이 프루닝 대상) 계산.
 *
 * 보호 tail을 "개수(protectTailCount)"와 "char 예산(protectTailChars)" 두 기준의
 * *더 작은 쪽*으로 정한다(= 둘 중 더 aggressive하게 프루닝). 즉:
 *  - 최근 결과가 작으면 → char 예산이 여유로우니 개수 기준(protectTailCount)으로 보호(기존 동작 보존).
 *  - 최근 결과가 크면 → char 예산이 먼저 차서 개수보다 적게 보호(큰 게 tail에 몰려도 잘림 — 우선순위4 핵심).
 * 단 최근 PRUNE_HARD_MIN_TAIL개는 무슨 일이 있어도 보존(직전 도구 결과 blind 방지).
 */
function findPruneBoundary(messages, protectTailChars, protectTailCount) {
  let acc = 0
  let i = messages.length - 1
  for (; i >= 0; i--) {
    acc += messageToolResultChars(messages[i])
    if (acc > protectTailChars) break
  }
  const byChars = Math.max(0, i + 1) // 0..i는 char 예산 밖(프루닝 대상)
  const byCount = messages.length - protectTailCount
  // 더 큰 boundary = 더 많이 프루닝 = 더 적게 보호.
  const boundary = Math.max(byChars, byCount)
  // 하드 플로어: 최근 PRUNE_HARD_MIN_TAIL개는 절대 프루닝하지 않음.
  return Math.max(0, Math.min(boundary, messages.length - PRUNE_HARD_MIN_TAIL))
}

/**
 * 보호 tail 밖의 오래된 tool_result를 1줄 요약으로 치환 (in-place mutate). LLM 미호출.
 * 멱등: 이미 마커가 붙은 결과·짧은 결과는 건너뛴다(재호출해도 안정).
 * @returns {number} 요약 치환한 tool_result 수
 */
export function pruneOldToolResults(
  messages,
  { protectTailCount = PRUNE_PROTECT_TAIL, protectTailChars = PRUNE_PROTECT_TAIL_CHARS } = {},
) {
  if (!Array.isArray(messages) || messages.length <= protectTailCount) return 0
  // tool_use_id → 도구 이름 (요약 라벨용). assistant 메시지의 tool_use 블록에서 수집.
  const toolNameById = new Map()
  for (const m of messages) {
    if (m && m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'tool_use') toolNameById.set(b.id, b.name)
      }
    }
  }
  const boundary = findPruneBoundary(messages, protectTailChars, protectTailCount)
  let pruned = 0
  for (let i = 0; i < boundary; i++) {
    const m = messages[i]
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (!b || b.type !== 'tool_result') continue
      // 이미지 블록을 품은 오래된 tool_result: base64는 toolResultText에서 0자로 잡혀
      // 아래 텍스트 프루닝(길이 임계)을 그냥 통과해 컨텍스트에 영구 잔존한다. 여기 도달하는
      // 건 보호 tail(최근 protectTailCount개) 밖뿐이므로, 멀어진 이미지의 base64를 치환해
      // 토큰을 회수한다. 원본 파일은 샌드박스(/workspace/.attachments 등)에 남아 있어,
      // 모델이 다시 봐야 하면 Read로 재로드할 수 있다(문맥 복구 경로 보존).
      if (Array.isArray(b.content) && b.content.some((c) => c && c.type === 'image')) {
        const name = toolNameById.get(b.tool_use_id) || 'tool'
        b.content = `${PRUNED_MARKER} [${name}] 이전 이미지 생략 — 다시 봐야 하면 해당 파일을 Read`
        pruned++
        continue
      }
      const text = toolResultText(b.content)
      if (text.startsWith(PRUNED_MARKER) || text.length <= PRUNE_MIN_CHARS) continue
      const name = toolNameById.get(b.tool_use_id) || 'tool'
      const status = b.is_error ? '오류' : '성공'
      b.content = `${PRUNED_MARKER} [${name}] ${status}, ${text.length}자`
      pruned++
    }
  }
  return pruned
}

// ── web server tool ──────────────────────────────────────────────────────
// Anthropic server-side tool — 서버가 검색/페치를 직접 실행하고 server_tool_use +
// web_search_tool_result/web_fetch_tool_result 블록을 같은 응답에 인라인한다. 클라이언트
// 실행(runTool) 불필요. agent-runner는 anthropic 단일이라 webTools capability='server'를
// 상수로 반영 (TS src/lib/llm/adapters/anthropic-adapter.ts ANTHROPIC_CAPS.webTools와 정합).
const WEB_SEARCH_SERVER_TOOL = Object.freeze({ type: 'web_search_20250305', name: 'web_search' })
const WEB_FETCH_SERVER_TOOL = Object.freeze({ type: 'web_fetch_20250910', name: 'web_fetch' })

// 도구 검색 서버 도구(A-1) — `defer_loading` 으로 내린 도구를 모델이 찾는 수단.
// 서버사이드라 왕복이 늘지 않는다: `server_tool_use → tool_search_tool_result → tool_use` 가
// **한 응답 안에서** 끝난다(실측).
//
// ⚠️ `name` 은 임의로 정할 수 없다 — `'tool_search_tool_regex'` 가 아니면 400 이다
// ("tools.0.tool_search_tool_regex_20251119.name: Input should be 'tool_search_tool_regex'").
// 베타 헤더는 필요 없다(Claude API 직접 호출 기준. Vertex·Bedrock 은 다를 수 있다).
const TOOL_SEARCH_SERVER_TOOL = Object.freeze({
  type: 'tool_search_tool_regex_20251119',
  name: 'tool_search_tool_regex',
})

// server_tool_use 결과 블록 — accumulateTurn이 final content에서 버리지 않고 보존해야
// 멀티턴 메시지 히스토리가 유효하고 검색 결과가 노출된다.
const SERVER_RESULT_BLOCK_TYPES = new Set([
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  // 지연 도구 검색 결과. 보존하지 않으면 그 턴의 assistant content 가 깨져 다음 턴 요청이 400 난다.
  'tool_search_tool_result',
])

// ── 모델별 max_tokens 테이블 ────────────────────────────────────────────────
// raw fetch 환경에서 max_tokens는 필수 필드. 16384 일괄 하드코딩 시 thinking 활성 모델이
// starve(thinking 토큰이 max_tokens를 잠식) 되므로 모델 ID로 substring 매칭해 산출.
// 등재되지 않은 모델은 ANTHROPIC_DEFAULT_OUTPUT_LIMIT 사용 (미래 모델은 더 작은 capacity일
// 가능성이 낮으므로 안전).
export const ANTHROPIC_OUTPUT_LIMITS = Object.freeze({
  // Claude 4.8
  'claude-opus-4-8': 128_000,
  // Claude 4.7
  'claude-opus-4-7': 128_000,
  // Claude 4.6
  'claude-opus-4-6': 128_000,
  'claude-sonnet-4-6': 64_000,
  // Claude 4.5
  'claude-opus-4-5': 64_000,
  'claude-sonnet-4-5': 64_000,
  'claude-haiku-4-5': 64_000,
  // Claude 4
  'claude-opus-4': 32_000,
  'claude-sonnet-4': 64_000,
  // Claude 3.7
  'claude-3-7-sonnet': 128_000,
  // Claude 3.5
  'claude-3-5-sonnet': 8_192,
  'claude-3-5-haiku': 8_192,
  // Claude 3
  'claude-3-opus': 4_096,
  'claude-3-sonnet': 4_096,
  'claude-3-haiku': 4_096,
})

export const ANTHROPIC_DEFAULT_OUTPUT_LIMIT = 128_000

/** Adaptive thinking 지원 세대 — 4.6/4.7/4.8. 매칭은 점·하이픈 양쪽 모두 시도(OpenRouter 호환). */
export const ADAPTIVE_THINKING_SUBSTRINGS = Object.freeze(['4-6', '4.6', '4-7', '4.7', '4-8', '4.8'])

/** xhigh effort 지원 세대 — 4.7+. 미지원 모델에서 xhigh 요청 시 'max'로 다운그레이드. */
export const XHIGH_EFFORT_SUBSTRINGS = Object.freeze(['4-7', '4.7', '4-8', '4.8'])

/** sampling param(temperature/top_p/top_k) 거부 세대 — 4.7+. 비기본값 전송 시 400. */
export const NO_SAMPLING_PARAMS_SUBSTRINGS = Object.freeze(['4-7', '4.7', '4-8', '4.8'])

/** Adaptive effort 매핑. legacy 'minimal'은 'low'로. */
const ADAPTIVE_EFFORT_MAP = Object.freeze({
  max: 'max',
  xhigh: 'xhigh',
  high: 'high',
  medium: 'medium',
  low: 'low',
  minimal: 'low',
})

/**
 * @typedef {{ type: 'text', text: string }} TextBlock
 * @typedef {{ type: 'tool_use', id: string, name: string, input: unknown }} ToolUseBlock
 * @typedef {TextBlock | ToolUseBlock} ContentBlock
 *
 * @typedef {{ type: 'tool_result', tool_use_id: string, content: string | Array<{type:'text', text:string}>, is_error?: boolean }} ToolResultBlock
 *
 * @typedef {{
 *   input_tokens: number,
 *   output_tokens: number,
 *   cache_read_input_tokens?: number,
 *   cache_creation_input_tokens?: number,
 *   cache_creation?: { ephemeral_5m_input_tokens?: number, ephemeral_1h_input_tokens?: number },
 * }} Usage
 *
 * `cache_creation` 은 쓰기 토큰의 **TTL 별 내역**이다(두 값의 합 = `cache_creation_input_tokens`).
 * daiops 는 TTL 을 섞어 쓰므로(system 1h · 메시지 꼬리 5m — `applyPromptCacheControl`) 이 내역이
 * 없으면 cloud 가 단가를 정확히 계산할 수 없다. 쓰기 단가가 5m 1.25배 · 1h 2.0배로 다르기 때문이다.
 * Anthropic 응답의 필드명을 **그대로** 통과시킨다 — 이름을 바꾸면 문서와 대조가 안 된다.
 *
 * @typedef {'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'model_context_window_exceeded'} AnthropicStopReason
 *
 * @typedef {{ name: string, description?: string, input_schema?: object }} ToolDef
 *
 * @typedef {Object} TurnManagerInput
 * @property {Array<{role:string, content: string | Array<unknown>}>} [messages] — role 분리 대화 시드.
 *   지정 시 이 배열로 messages를 시드한다(히스토리를 <conversation_history>/<turn> XML로 납작하게
 *   만들지 않아 모델이 내부 태그를 흉내내 뱉는 프라이밍을 제거 — 내부 태그 누출 근본 수정).
 *   Anthropic API 제약(role 교대·첫 메시지 user)은 normalizeConversationMessages가 보정한다.
 * @property {string} [prompt] — messages 미지정 시 단일 user turn 폴백(하위호환: 테스트·단발 변환 경로).
 * @property {Object} options
 * @property {string} options.model
 * @property {string | Array<{type:'text', text:string, cache_control?:object}>} [options.systemPrompt]
 * @property {ToolDef[]} [options.tools]
 * @property {string[]} [options.allowedTools] — 정보용. 실제 tool 정의는 options.tools.
 * @property {number} [options.maxTurns]
 * @property {number} [options.maxTokens] — 미지정 시 모델 ID로 자동 산출
 * @property {{ effort?: 'low'|'medium'|'high'|'xhigh'|'max'|'minimal' } | false} [options.thinking] — 4.6/4.7 adaptive 자동, false로 비활성
 * @property {{ ttl?: '5m' | '1h' } | false} [options.cacheControl] — system_and_3, 기본 1h, false로 비활성
 * @property {number} [options.temperature] — 4.7+에서는 자동 제거
 * @property {number} [options.topP]
 * @property {number} [options.topK]
 * @property {Array<{name:string, url:string, transport?:'http', headers?:Record<string,string>}>} [options.mcpServers] — 자동 registry + routing wrapper
 * @property {string} [options.structuredToolName] — 설정 시 이 도구로 구조화 최종 응답을 강제·검증(AGENT-API-2/5)
 * @property {'final_turn'|'immediate'} [options.structuredMode] — 구조화 강제 시점. 'final_turn'(기본)=도구 선사용 후 end_turn에서만 강제, 'immediate'=turn 0부터 강제(단발 변환)
 *
 * @typedef {{ behavior: 'allow', updatedInput?: unknown } | { behavior: 'deny', message?: string }} CanUseToolResult
 *
 * @typedef {Object} TurnManagerCtx
 * @property {AbortSignal} [signal]
 * @property {string} [apiKey] — 미지정 시 process.env.ANTHROPIC_API_KEY
 * @property {string} [apiUrl] — 미지정 시 https://api.anthropic.com/v1/messages
 * @property {(toolName: string, input: unknown, meta?: { serverName: string, originalName: string, annotations?: { readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean } }) => Promise<CanUseToolResult> | CanUseToolResult} [canUseTool] — `meta` 는 MCP 도구일 때만 채워진다(mcpRegistry.getToolMeta). 게이트가 외부 서버의 쓰기 도구를 판정하는 유일한 근거다.
 * @property {(toolName: string, input: unknown, ctx: { signal?: AbortSignal }) => Promise<{ content: string | Array<{type:'text', text:string}>, is_error?: boolean }>} [runTool]
 * @property {typeof globalThis.fetch} [fetchFn] — Anthropic Messages API용 테스트 주입.
 * @property {typeof globalThis.fetch} [mcpFetchFn] — MCP HTTP 호출용 테스트 주입 (미지정 시 fetchFn 재사용).
 * @property {{ tools: Array<any>, runTool: Function, getToolMeta?: Function, close: () => Promise<void> }} [mcpRegistry] — 외부 관리 registry. 주입 시 mcpServers 자동 생성 스킵. `getToolMeta` 미구현 registry(구 테스트 더블)면 meta 없이 진행한다.
 * @property {(info: { attempt: number, delayMs: number, reason: string, status?: number }) => void} [onRetry] — turn 1+ per-turn 재시도 및 thinking 서명 복구 시 호출 (handler가 retry SSE로 가시화).
 * @property {{ baseMs?: number, maxMs?: number, jitterRatio?: number, maxAttempts?: number }} [retryOpts] — turn 1+ per-turn 재시도 backoff 파라미터 (미지정 시 retry-utils DEFAULT_BACKOFF). 주로 테스트용.
 * @property {(delta: string, index: number) => void} [onPartialText] — text 블록의 text_delta 도착 시점마다 호출. 호출자가 토큰 단위 라이브 표시(SSE text_delta 등)에 사용. 콜백 실패는 본 흐름에 영향 없음.
 */

/**
 * Anthropic stop_reason → SDK result.subtype 매핑.
 * SDK 호환: end_turn/stop_sequence/refusal → success, max_tokens → error_max_turns.
 * model_context_window_exceeded → error_context_overflow: 컨텍스트 한도 초과는 정상 end-of-turn이
 * 아니라 *잘린* 응답이다. success로 매핑하면 호출자가 절단을 완료로 오인한다(silent truncation).
 * 호출자(handler.js)가 이 subtype을 error SSE로 surface하고, REF-T1 압축의 트리거로 쓴다.
 * (레퍼런스 근거: hermes는 이 stop_reason을 "length"로 매핑하며 normal end-of-turn 취급을 명시적으로
 *  금지 — anthropic_adapter.py:1501-1516. opencode/openhuman도 overflow를 success로 두지 않는다.)
 *
 * @param {AnthropicStopReason | null | undefined} stopReason
 * @returns {'success' | 'error_max_turns' | 'error_context_overflow'}
 */
export function stopReasonToResultSubtype(stopReason) {
  if (stopReason === 'max_tokens') return 'error_max_turns'
  if (stopReason === 'model_context_window_exceeded') return 'error_context_overflow'
  return 'success'
}

/**
 * 모델 이름 정규화 — 'anthropic/' 접두사 제거 + 버전 분리자 점·하이픈 모두 보존(소문자).
 * substring 매칭이 점·하이픈 양쪽 표기를 모두 인식하도록 *원본* 형식을 유지. (OpenRouter는 점,
 * Anthropic 공식은 하이픈을 쓰므로 사용자 입력 양쪽을 그대로 받는다.)
 *
 * @param {string} model
 */
function normalizeModelName(model) {
  let m = String(model ?? '').toLowerCase().trim()
  if (m.startsWith('anthropic/')) m = m.slice('anthropic/'.length)
  return m
}

/**
 * 모델 ID로 max output tokens 조회 — longest-prefix 매칭. 점 표기('opus-4.6')는 하이픈
 * 표기('opus-4-6')로도 한 번 더 조회해 양쪽 호환.
 *
 * @param {string} model
 * @returns {number}
 */
export function getAnthropicMaxOutput(model) {
  const m = normalizeModelName(model)
  const candidates = [m]
  if (m.includes('.')) candidates.push(m.replace(/\./g, '-'))
  let bestKey = ''
  let bestVal = ANTHROPIC_DEFAULT_OUTPUT_LIMIT
  for (const cand of candidates) {
    for (const [key, val] of Object.entries(ANTHROPIC_OUTPUT_LIMITS)) {
      if (cand.includes(key) && key.length > bestKey.length) {
        bestKey = key
        bestVal = val
      }
    }
  }
  return bestVal
}

// ── 모델별 컨텍스트 윈도우(입력 토큰 한도) ─────────────────────────────────
// offload per-turn 예산 산출(A4)에 사용. 표준 Claude=200K, 1M 베타 변형만 예외.
// (max_tokens는 출력 한도라 별개 — 위 ANTHROPIC_OUTPUT_LIMITS.)
export const ANTHROPIC_DEFAULT_CONTEXT_WINDOW = 200_000
export const ANTHROPIC_1M_CONTEXT_WINDOW = 1_000_000
/** 1M 컨텍스트 베타를 나타내는 모델 ID 마커(lowercase, normalizeModelName 후 매칭). */
const CONTEXT_1M_SUBSTRINGS = Object.freeze(['[1m]', '-1m', '1m-context'])

/** @param {string} model @returns {number} 컨텍스트 윈도우(토큰) */
export function getAnthropicContextWindow(model) {
  const m = normalizeModelName(model)
  return CONTEXT_1M_SUBSTRINGS.some((s) => m.includes(s))
    ? ANTHROPIC_1M_CONTEXT_WINDOW
    : ANTHROPIC_DEFAULT_CONTEXT_WINDOW
}

/** offload per-turn 예산이 차지할 컨텍스트 윈도우 비율(openclaw calculateMaxToolResultChars window×0.3 차용). */
const OFFLOAD_WINDOW_FRACTION = (() => {
  const v = Number(process.env.AGENT_RUNNER_OFFLOAD_WINDOW_FRACTION)
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.3
})()

/**
 * offload per-turn 예산(chars) 산출.
 * env override(AGENT_RUNNER_TURN_RESULT_BUDGET_CHARS)가 있으면 절대값 우선(운영 override),
 * 없으면 모델 컨텍스트 window × fraction × CHARS_PER_TOKEN. 200K chars 고정이 실제 200K '토큰'
 * window와 단위 불일치(≈50K토큰)라 큰 window 모델에서 과도 오프로드하던 것을 정합(A4).
 * @param {string} model @returns {number}
 */
export function resolveOffloadBudgetChars(model) {
  const envRaw = Number(process.env.AGENT_RUNNER_TURN_RESULT_BUDGET_CHARS)
  if (Number.isFinite(envRaw) && envRaw > 0) return envRaw
  return Math.round(getAnthropicContextWindow(model) * OFFLOAD_WINDOW_FRACTION * CHARS_PER_TOKEN)
}

/** @param {string} model */
export function supportsAdaptiveThinking(model) {
  const m = normalizeModelName(model)
  return ADAPTIVE_THINKING_SUBSTRINGS.some((v) => m.includes(v))
}

/** @param {string} model */
export function supportsXhighEffort(model) {
  const m = normalizeModelName(model)
  return XHIGH_EFFORT_SUBSTRINGS.some((v) => m.includes(v))
}

/** @param {string} model */
export function forbidsSamplingParams(model) {
  const m = normalizeModelName(model)
  return NO_SAMPLING_PARAMS_SUBSTRINGS.some((v) => m.includes(v))
}

/**
 * system_and_3 cache 전략 — 메시지 prefix를 4개까지 cache_control 마커로 표시.
 *  - system 프롬프트가 있으면 첫 마커 (마지막 text 블록에 부착) → model+tools+system 캐시.
 *  - 마지막 3개 *non-system* 메시지의 마지막 콘텐츠 블록에 마커 → 누적 prefix 캐시.
 *  - 합계 ≤ 4 (Anthropic 한도). 메시지가 3개 미만이면 그만큼만.
 *
 * ## system 과 메시지 꼬리는 TTL 이 다르다 (2026-08-13)
 *
 * 캐시 **쓰기**는 정가보다 비싸다 — 5분권 1.25배, 1시간권 2.0배. 읽기만 0.1배로 싸다.
 * 그래서 "몇 번 읽히느냐"가 TTL 선택을 정한다(손익분기: 5m 은 2회, 1h 는 3회).
 *
 *  - **system 블록**은 워크스페이스가 사는 동안 수십~수백 번 읽힌다 → 1h 가 압도적으로 이득.
 *    5m 으로 내리면 턴 간격이 5분만 넘어도 79k 를 통째로 재작성한다.
 *  - **메시지 꼬리**는 같은 턴 안에서 0~2회 읽히고 버려진다. 도구를 부를 때마다 꼬리가
 *    뒤로 밀려 *새 접미사*가 생기므로, 그 엔트리는 다음 호출 한두 번이 수명의 전부다.
 *    1h(2.0배)를 매기면 **캐시를 안 쓰는 것(2.0배)보다 비싸진다** — 손익분기 미달이다.
 *
 * 종전에는 마커를 하나만 만들어 네 곳에 같이 썼고, cloud 가 ttl 을 넘기지 않아 전부 1h 였다.
 * 프로덕션 실측(lattice chat, 2026-08-12, 201턴)에서 턴당 쓰기가 34,041토큰이었고 그 비용이
 * 턴 원가의 68%를 차지했다. 레퍼런스 3종(prime-agent `resolveCacheRetention` 기본 "short",
 * opencode `applyCaching` ttl 미지정, vellum)은 모두 5분이 기본이고 1시간은 옵트인이다.
 *
 * 호출자 약속: 입력 messages는 본 함수가 deep-clone하지 않으므로, in-place 수정에 동의해야
 * 한다 (turn-manager 내부에서 매 turn마다 새로 빌드한 messages만 전달).
 *
 * @param {{
 *   system: string | Array<{type:'text', text:string, cache_control?:object}> | undefined,
 *   messages: Array<{role:'user'|'assistant', content: string | Array<any>}>,
 *   ttl?: '5m' | '1h',
 *   systemTtl?: '5m' | '1h',
 *   tailTtl?: '5m' | '1h',
 * }} args
 *   `ttl` 은 하위호환 별칭 — **system 쪽에만** 적용된다(꼬리는 `tailTtl`).
 * @returns {{
 *   system: string | Array<{type:'text', text:string, cache_control?:object}> | undefined,
 *   messages: Array<{role:'user'|'assistant', content: string | Array<any>}>,
 *   breakpoints: number,
 * }}
 */
export function applyPromptCacheControl(args) {
  const mkMarker = (ttl) => (ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' })
  const systemMarker = mkMarker(args.systemTtl ?? args.ttl ?? '1h')
  const tailMarker = mkMarker(args.tailTtl ?? '5m')

  let system = args.system
  const messages = args.messages.map((m) => ({ ...m, content: cloneContent(m.content) }))

  let breakpoints = 0

  // 1) system 마커 — 항상 마지막 text 블록에 부착. string은 array of text block으로 승격.
  if (system) {
    if (typeof system === 'string') {
      system = [{ type: 'text', text: system, cache_control: systemMarker }]
    } else if (Array.isArray(system) && system.length > 0) {
      // 마지막 dict-like 블록에 부착 (immutable copy를 만들지 않으면 호출자 system 객체 수정).
      system = system.map((blk, i) => (i === system.length - 1 ? { ...blk, cache_control: systemMarker } : blk))
    }
    breakpoints++
  }

  // 2) 마지막 3개 non-system 메시지에 마커. messages는 system role을 포함하지 않는 가정.
  const remaining = 4 - breakpoints
  if (remaining > 0 && messages.length > 0) {
    const startIdx = Math.max(0, messages.length - remaining)
    for (let i = startIdx; i < messages.length; i++) {
      attachCacheMarker(messages[i], tailMarker)
      breakpoints++
    }
  }

  return { system, messages, breakpoints }
}

/** @param {string | Array<any>} content */
function cloneContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' ? { ...b } : b))
  return content
}

/**
 * 메시지 1건에 cache_control 마커를 부착.
 *  - string content → array of text block(s)으로 승격 후 마지막 블록에 부착.
 *  - array content → 마지막 dict-like 블록에 부착.
 *  - 빈 string → 안전 placeholder text 블록으로 변환 후 부착 (Anthropic은 빈 content 거부).
 *
 * @param {{role: string, content: any}} msg
 * @param {object} marker
 */
function attachCacheMarker(msg, marker) {
  const c = msg.content
  if (c == null || c === '') {
    msg.content = [{ type: 'text', text: '(empty)', cache_control: marker }]
    return
  }
  if (typeof c === 'string') {
    msg.content = [{ type: 'text', text: c, cache_control: marker }]
    return
  }
  if (Array.isArray(c) && c.length > 0) {
    const lastIdx = c.length - 1
    const last = c[lastIdx]
    if (last && typeof last === 'object') {
      c[lastIdx] = { ...last, cache_control: marker }
    }
  }
}

/**
 * Adaptive thinking 옵션 빌드. 4.6/4.7 세대에서만 활성, 외 모델은 null 반환.
 * effort 'xhigh'는 4.7+에서만 수용 — 그 외에서는 'max'로 다운그레이드.
 *
 * @param {string} model
 * @param {{ effort?: 'low'|'medium'|'high'|'xhigh'|'max'|'minimal' } | undefined | false} thinking
 * @returns {{ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: string } } | null}
 */
export function buildThinkingOptions(model, thinking) {
  if (thinking === false) return null
  if (!supportsAdaptiveThinking(model)) return null
  const effortRaw = (thinking && thinking.effort) ? String(thinking.effort).toLowerCase() : 'medium'
  let effort = ADAPTIVE_EFFORT_MAP[effortRaw] ?? 'medium'
  if (effort === 'xhigh' && !supportsXhighEffort(model)) effort = 'max'
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort },
  }
}

/**
 * SSE 스트림 파서 — ReadableStream<Uint8Array> 또는 호환 async iterable을 받아
 * Anthropic SSE 이벤트(`{event, data}`) async iter로 변환.
 *
 *  - `event: <type>\ndata: <json>\n\n` 형식만 지원. data가 여러 줄이면 이어붙임.
 *  - data: 가 JSON parse 실패하면 해당 블록 skip (잘못된 keepalive 등).
 *  - 마지막 chunk가 \n\n로 끝나지 않으면 buffer에 남아 손실되지 않음.
 *
 * @param {ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>} stream
 * @returns {AsyncGenerator<{event: string, data: any}>}
 */
export async function* parseAnthropicSSE(stream) {
  const decoder = new TextDecoder()
  let buffer = ''

  /** @param {Uint8Array | string} chunk */
  const append = (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  }

  // ReadableStream과 AsyncIterable 양쪽 모두 지원
  // (Node 24 fetch는 body가 ReadableStream — getReader. 테스트에서는 async generator 직접 주입 가능.)
  const iterable = isReadableStream(stream)
    ? readableStreamToAsyncIterable(stream)
    : stream

  for await (const chunk of iterable) {
    append(chunk)
    let idx
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const ev = parseSseBlock(block)
      if (ev) yield ev
    }
  }

  // 남은 buffer 마지막 처리 (drained terminator 누락 대응)
  if (buffer.length > 0) {
    const ev = parseSseBlock(buffer)
    if (ev) yield ev
  }
}

/** @param {unknown} x */
function isReadableStream(x) {
  return !!x && typeof (/** @type {any} */ (x).getReader) === 'function'
}

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function* readableStreamToAsyncIterable(stream) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) yield value
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

/**
 * stale watchdog — chunk 단위 async iterable을 감싸, 각 `next()`를 idle 타임아웃과 race한다.
 * `idleMs` 안에 다음 chunk가 도착하지 않으면 `onStale()`(연결 abort 등)을 호출하고 retryable
 * timeout 에러(`code: 'ETIMEDOUT'`)를 throw한다. chunk가 흐르는 동안에는 타이머가 매번 리셋돼
 * 정상 스트림에는 영향이 없다.
 *
 * 던지는 에러를 `code: 'ETIMEDOUT'`로 표시하는 이유: retry-utils.classifyLlmError가 이를
 * `timeout`(retryable)로 분류 → turn 0은 handler의 asyncIteratorWithFirstYieldRetry,
 * turn 1+는 turn-manager의 withJitteredRetry가 자동으로 같은 turn을 재시도한다(둘 다 retry SSE로 가시화).
 *
 * 트레이드오프: stale은 대개 TTFB 구간(토큰 흐르기 전)에서 발생하므로 재시도가 깨끗하다.
 * 드물게 일부 텍스트가 흐른 뒤 stale가 나면 재시도로 텍스트가 한 번 중복될 수 있으나,
 * 최종 `done` 이벤트의 content가 진실 소스라 결과는 교정된다 — 750초 hang보다 압도적으로 낫다.
 *
 * @param {ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>} stream
 * @param {number} idleMs
 * @param {() => void} onStale — stale 감지 시 1회 호출 (보통 fetch AbortController.abort()).
 * @returns {AsyncGenerator<Uint8Array | string>}
 */
export async function* streamWithStaleGuard(stream, idleMs, onStale) {
  const iterable = isReadableStream(stream) ? readableStreamToAsyncIterable(stream) : stream
  const iterator = iterable[Symbol.asyncIterator] ? iterable[Symbol.asyncIterator]() : iterable
  try {
    while (true) {
      const nextP = Promise.resolve(iterator.next())
      let timer
      const idleP = new Promise((_, reject) => {
        timer = setTimeout(() => reject(STREAM_STALE), idleMs)
        timer.unref?.()
      })
      let result
      try {
        result = await Promise.race([nextP, idleP])
      } catch (err) {
        if (err === STREAM_STALE) {
          // 아직 살아있는 read promise는 onStale의 abort로 곧 reject됨 — unhandled 방지로 swallow.
          nextP.catch(() => {})
          try { onStale() } catch { /* best-effort */ }
          throw Object.assign(new Error(`Anthropic stream stalled (no data for ${idleMs}ms)`), {
            code: 'ETIMEDOUT',
            stale: true,
          })
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
      if (result.done) return
      yield result.value
    }
  } finally {
    // inner iterator 정리를 await해 throw 전파 전에 완전히 끝낸다(미settle promise 잔류 방지).
    // 모든 진입 경로에서 await가 안전한 이유 — finally 시점엔 소스의 pending read가 이미 settle됨:
    //   · stale: 위에서 onStale()이 fetch를 abort → reader.read()가 reject → 소스 finally(releaseLock) 진행
    //   · 정상: while이 done까지 소진해 소스가 이미 종료
    //   · 부모 abort/네트워크 오류: read가 reject돼 동일하게 정리
    // 따라서 return()은 곧바로 resolve되며 hang이 없다(abort 미연동 소스만 hang 위험 — 실경로엔 없음).
    try { await iterator.return?.() } catch { /* already done / not resumable */ }
  }
}

/** @param {string} block */
function parseSseBlock(block) {
  let event = ''
  let dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!event) return null
  const dataText = dataLines.join('')
  if (!dataText) return { event, data: null }
  try {
    return { event, data: JSON.parse(dataText) }
  } catch {
    return null
  }
}

/**
 * SSE 이벤트 시퀀스를 누적해 완성된 `{ content: ContentBlock[], usage: Usage, stop_reason }`를
 * 한 turn 단위로 반환. content_block_start/delta/stop을 인덱스별 슬롯에 누적.
 *
 *  - text 블록: text_delta의 .text를 이어붙임.
 *  - tool_use 블록: input_json_delta의 .partial_json을 문자열로 이어붙인 뒤 JSON.parse.
 *    (Anthropic은 input을 partial_json delta로 스트리밍. 빈 input은 빈 문자열.)
 *  - thinking 블록: 누적은 하되 yield content에는 포함하지 않음 (3.2 범위).
 *  - usage: message_start.message.usage + message_delta.usage의 union (이후 값이 우선).
 *
 * 또한 text 블록의 text_delta 도착 시점마다 `opts.onPartialText(delta, index)` 콜백을 호출 —
 * 호출자가 토큰 단위로 외부(SSE 등)로 흘릴 수 있게 한다. partial은 누적 결과(content)에 이미 반영된 상태.
 * 콜백 패턴인 이유: 기존 yield 시그니처를 유지해 호출자(테스트 포함)가 final assistant 를 [0] 으로 잡는 가정을 깨지 않음.
 *
 * @param {AsyncIterable<{event:string, data:any}>} events
 * @param {{ onPartialText?: (delta: string, index: number) => void }} [opts]
 * @yields {{ kind: 'assistant', content: ContentBlock[], usage: Usage, stop_reason: AnthropicStopReason | null }
 *        | { kind: 'error', error: { code: string, message: string } }}
 */
export async function* accumulateTurn(events, opts = {}) {
  /** @type {Array<ContentBlock & { _partialJson?: string }>} */
  const blocks = []
  /** @type {Usage} */
  let usage = { input_tokens: 0, output_tokens: 0 }
  /** @type {AnthropicStopReason | null} */
  let stop_reason = null
  let messageStopped = false

  for await (const { event, data } of events) {
    if (event === 'ping') continue

    if (event === 'error') {
      const err = data?.error ?? { type: 'api_error', message: 'unknown SSE error' }
      yield { kind: 'error', error: { code: String(err.type ?? 'api_error'), message: String(err.message ?? '') } }
      return
    }

    if (event === 'message_start') {
      const u = data?.message?.usage
      if (u) {
        usage = {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          ...(u.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
          ...(u.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}),
          ...(u.cache_creation ? { cache_creation: u.cache_creation } : {}),
        }
      }
      continue
    }

    if (event === 'content_block_start') {
      const idx = data?.index ?? 0
      const block = data?.content_block
      if (!block) continue
      if (block.type === 'text') {
        blocks[idx] = { type: 'text', text: typeof block.text === 'string' ? block.text : '' }
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        // server_tool_use도 input이 input_json_delta로 스트리밍됨 (tool_use와 동일 처리).
        // 단 finalAssistantBlocks 합성 루프(type!=='tool_use')에서 runTool 라우팅은 안 됨 — Anthropic이
        // 서버에서 이미 실행하고 결과 블록을 동봉하므로 클라이언트 실행 불필요.
        blocks[idx] = {
          type: block.type,
          id: String(block.id ?? ''),
          name: String(block.name ?? ''),
          input: block.input ?? {},
          _partialJson: '',
        }
      } else if (SERVER_RESULT_BLOCK_TYPES.has(block.type)) {
        // web_search_tool_result 등 — content_block_start에 완성형으로 도착. 원본 그대로 보존.
        blocks[idx] = /** @type {any} */ ({ ...block, _passthrough: true })
      } else if (block.type === 'thinking') {
        // 멀티턴 정합(P1): thinking 활성 + tool_use 시 Anthropic은 직전 assistant turn의 thinking 블록
        // (서명 포함)을 다음 요청에 동봉할 것을 요구한다. thinking_delta/signature_delta로 누적.
        // UI로는 노출되지 않음 — sdkMessageToLLMEvents가 text/tool 블록만 emit (web "thinking 토글"은
        // stage·tool·답변 텍스트로 구성, reasoning 토큰 필드 없음).
        blocks[idx] = /** @type {any} */ ({ type: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '', signature: typeof block.signature === 'string' ? block.signature : '' })
      } else if (block.type === 'redacted_thinking') {
        // content_block_start에 data(암호화)가 완성형으로 도착 — 원본 그대로 보존.
        blocks[idx] = /** @type {any} */ ({ type: 'redacted_thinking', data: typeof block.data === 'string' ? block.data : '' })
      } else {
        // 알 수 없는 블록 타입 — placeholder만 두고 final content에서 제외.
        blocks[idx] = /** @type {any} */ ({ type: block.type, _excluded: true })
      }
      continue
    }

    if (event === 'content_block_delta') {
      const idx = data?.index ?? 0
      const slot = blocks[idx]
      const delta = data?.delta
      if (!slot || !delta) continue
      if (delta.type === 'text_delta' && slot.type === 'text') {
        const t = typeof delta.text === 'string' ? delta.text : ''
        slot.text += t
        // 토큰 단위 라이브 표시 — opts.onPartialText 콜백으로 즉시 통지(yield 패턴 영향 없음).
        if (t && opts.onPartialText) {
          try { opts.onPartialText(t, idx) } catch { /* noop — 본 흐름 영향 없음 */ }
        }
      } else if (
        delta.type === 'input_json_delta' &&
        (slot.type === 'tool_use' || slot.type === 'server_tool_use')
      ) {
        slot._partialJson = (slot._partialJson ?? '') + (delta.partial_json ?? '')
      } else if (delta.type === 'thinking_delta' && slot.type === 'thinking') {
        slot.thinking += typeof delta.thinking === 'string' ? delta.thinking : ''
      } else if (delta.type === 'signature_delta' && slot.type === 'thinking') {
        // 서명은 단일 delta로 오는 게 일반적이나 누적으로 안전 처리.
        slot.signature += typeof delta.signature === 'string' ? delta.signature : ''
      }
      continue
    }

    if (event === 'content_block_stop') {
      const idx = data?.index ?? 0
      const slot = blocks[idx]
      if (
        slot &&
        (slot.type === 'tool_use' || slot.type === 'server_tool_use') &&
        slot._partialJson !== undefined
      ) {
        const raw = slot._partialJson
        if (raw === '') {
          slot.input = {}
        } else {
          try {
            slot.input = JSON.parse(raw)
          } catch {
            // Anthropic이 partial_json을 잘못 끊는 경우는 드물지만, 안전 fallback.
            slot.input = {}
          }
        }
        delete slot._partialJson
      }
      continue
    }

    if (event === 'message_delta') {
      const dStop = data?.delta?.stop_reason
      if (dStop) stop_reason = dStop
      const dU = data?.usage
      if (dU) {
        if (typeof dU.output_tokens === 'number') usage.output_tokens = dU.output_tokens
        if (typeof dU.input_tokens === 'number') usage.input_tokens = dU.input_tokens
        if (typeof dU.cache_read_input_tokens === 'number') usage.cache_read_input_tokens = dU.cache_read_input_tokens
        if (typeof dU.cache_creation_input_tokens === 'number') usage.cache_creation_input_tokens = dU.cache_creation_input_tokens
        // 내역은 통째로 교체한다 — 두 값의 합이 cache_creation_input_tokens 와 맞아야 하므로
        // 필드별로 부분 갱신하면 delta 가 한쪽만 보낼 때 합이 어긋난다.
        if (dU.cache_creation) usage.cache_creation = dU.cache_creation
      }
      continue
    }

    if (event === 'message_stop') {
      messageStopped = true
      break
    }
  }

  if (!messageStopped) {
    // 스트림이 message_stop 없이 종료 — 부분 결과 그대로 반환 (호출자가 stop_reason null 처리).
  }

  /** @type {ContentBlock[]} */
  const finalContent = []
  for (const b of blocks) {
    if (!b) continue
    if (/** @type {any} */ (b)._excluded) continue
    if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      const { _partialJson: _ignore, ...rest } = /** @type {any} */ (b)
      finalContent.push(rest)
    } else if (b.type === 'text') {
      finalContent.push({ type: 'text', text: b.text })
    } else if (b.type === 'thinking') {
      // 서명이 있는 thinking 블록만 보존. 서명 없는 블록(요약형 등)을 되돌려보내면 400을 유발하므로
      // 그 경우 드롭 — 기존 _excluded 동작과 동일해 회귀 없음. 서명 무효 시 turn 루프의 1회 복구가 처리.
      const sig = /** @type {any} */ (b).signature
      if (sig) finalContent.push({ type: 'thinking', thinking: /** @type {any} */ (b).thinking ?? '', signature: sig })
    } else if (b.type === 'redacted_thinking') {
      const data = /** @type {any} */ (b).data
      if (data) finalContent.push({ type: 'redacted_thinking', data })
    } else if (/** @type {any} */ (b)._passthrough) {
      // web_search_tool_result 등 server tool 결과 — _passthrough 마커만 제거하고 원본 보존.
      const { _passthrough: _ignore, ...rest } = /** @type {any} */ (b)
      finalContent.push(rest)
    }
  }

  yield { kind: 'assistant', content: finalContent, usage, stop_reason }
}

/**
 * Anthropic 요청 본문 직렬화. 3.2 정규화 layer 포함.
 *
 *  - `maxTokens` 미지정 시 `getAnthropicMaxOutput(model)`로 자동 산출 (모델별 테이블).
 *  - `thinking !== false` 이고 모델이 adaptive thinking 지원 세대(4.6/4.7)면 자동 활성화.
 *    `thinking.effort` (기본 'medium')에 따라 output_config.effort 설정. xhigh는 4.7+에서만.
 *  - `cacheControl !== false` 이면 system + 마지막 3개 non-system 메시지에 ephemeral 마커
 *    삽입 (system_and_3 전략). 기본 TTL은 **system 1h · 꼬리 5m** — 근거는
 *    `applyPromptCacheControl` 헤더("system 과 메시지 꼬리는 TTL 이 다르다").
 *  - 4.7+ 모델에서는 temperature/top_p/top_k가 비기본값이면 자동 제거.
 *
 * @param {{
 *   model: string,
 *   systemPrompt?: string | Array<{type:'text', text:string, cache_control?:object}>,
 *   messages: Array<{role:'user'|'assistant', content: string | Array<unknown>}>,
 *   tools?: ToolDef[],
 *   maxTokens?: number,
 *   thinking?: { effort?: 'low'|'medium'|'high'|'xhigh'|'max'|'minimal' } | false,
 *   cacheControl?: { ttl?: '5m' | '1h', systemTtl?: '5m' | '1h', tailTtl?: '5m' | '1h' } | false,
 *   temperature?: number,
 *   topP?: number,
 *   topK?: number,
 *   webTools?: { search?: 'server'|'none', fetch?: 'server'|'none' },
 * }} args
 */
export function buildAnthropicRequest(args) {
  /** @type {Record<string, unknown>} */
  const body = {
    model: args.model,
    max_tokens: args.maxTokens ?? getAnthropicMaxOutput(args.model),
    stream: true,
  }

  // ── prompt cache 마커 적용 ──────────────────────────────────────────
  let system = args.systemPrompt
  let messages = args.messages
  if (args.cacheControl !== false) {
    // 미지정은 그대로 넘긴다 — 기본값(system 1h · 꼬리 5m) 판정은 applyPromptCacheControl 한 곳에만 둔다.
    const cached = applyPromptCacheControl({
      system,
      messages,
      systemTtl: args.cacheControl?.systemTtl ?? args.cacheControl?.ttl,
      tailTtl: args.cacheControl?.tailTtl,
    })
    system = cached.system
    messages = cached.messages
  }
  body.messages = messages
  if (system) body.system = system

  // ── tools 머지 + web server tool 자동 추가 (5.4) ────────────────────
  /** @type {Array<any>} */
  const tools = []
  if (args.tools && args.tools.length > 0) tools.push(...args.tools)
  if (args.webTools?.search === 'server') tools.push(WEB_SEARCH_SERVER_TOOL)
  if (args.webTools?.fetch === 'server') tools.push(WEB_FETCH_SERVER_TOOL)
  // 지연된 도구가 하나라도 있으면 모델이 그것을 찾을 수단을 함께 준다(A-1).
  // 안 주면 지연된 도구는 **존재하지 않는 것과 같아진다.**
  if (tools.some((t) => t?.defer_loading)) tools.push(TOOL_SEARCH_SERVER_TOOL)
  if (tools.length > 0) body.tools = tools

  // ── 구조화 출력(AGENT-API-2): 특정 도구 강제 호출 ───────────────────
  // toolChoice가 있으면 해당 도구를 반드시 호출하도록 강제(response_schema 구조화 출력).
  if (args.toolChoice) body.tool_choice = args.toolChoice

  // ── adaptive thinking 자동 wiring ───────────────────────────────────
  // ★ 강제 tool_choice(type:'tool'/'any')와 thinking은 Anthropic에서 공존 불가 — thinking이 켜진 채
  //   강제 tool_choice를 보내면 400("Thinking may not be enabled when tool_choice forces tool use").
  //   구조화 출력은 tool_choice를 강제하므로, toolChoice가 설정되면 thinking을 끈다.
  const thinkingCfg = body.tool_choice ? null : buildThinkingOptions(args.model, args.thinking)
  if (thinkingCfg) {
    body.thinking = thinkingCfg.thinking
    body.output_config = thinkingCfg.output_config
  }

  // ── sampling param 패스스루 + 4.7+ 자동 제거 ────────────────────────
  if (typeof args.temperature === 'number') body.temperature = args.temperature
  if (typeof args.topP === 'number') body.top_p = args.topP
  if (typeof args.topK === 'number') body.top_k = args.topK
  if (forbidsSamplingParams(args.model)) {
    delete body.temperature
    delete body.top_p
    delete body.top_k
  }

  return body
}

/**
 * upstream(Anthropic 직접 vs cloud LLM proxy) URL + 헤더 결정 (5.5).
 *
 *  - `ctx.apiUrl` 명시 주입 시: 그 URL + direct Anthropic 헤더 (테스트·외부 제어).
 *  - `process.env.LLM_PROXY_URL` 설정 시: cloud proxy 경유. `Authorization: Bearer ${AGENT_RUNNER_TOKEN}`
 *    + `x-workspace-id: ${WORKSPACE_ID}`. sandbox env에 ANTHROPIC_API_KEY 부재 — 키는 cloud만 보유.
 *  - 둘 다 없으면: 기존 direct Anthropic (`x-api-key`). **로컬·테스트 전용 fallback.**
 *
 * `ctx.messageId`가 있으면 proxy 경로에 한해 `x-daiops-message-id`를 함께 보낸다 — cloud가
 * LLM 호출 1건을 어느 turn의 것인지 기록하기 위한 좌표다(llm_usage_logs.message_id).
 * 그게 없으면 cloud는 (workspace_id, created_at) 시간창으로 추측할 수밖에 없는데, 한 워크스페이스에
 * turn이 동시에 최대 19개까지 뜨는 실측(2026-08-03) 때문에 호출의 85%가 미귀속으로 남았다.
 * env가 아니라 ctx로 받는 이유: 같은 sandbox가 여러 turn을 동시에 돌리므로 프로세스 전역 값이 될 수 없다.
 * direct Anthropic 경로에는 붙이지 않는다(업스트림이 모르는 헤더 — 400 위험).
 *
 * 프로덕션 가드(P0): 배포된 sandbox는 deployer가 `LLM_PROXY_URL`+`WORKSPACE_ID`를 주입하고
 * `ANTHROPIC_API_KEY`는 제거한다(Phase B 격리 목표). 따라서 프로덕션 신호
 * (`NODE_ENV==='production'` 또는 `WORKSPACE_ID` 존재)가 있는데 `LLM_PROXY_URL`이 비어 있으면
 * env 구성 오류다. 이때 direct fallback으로 흘러가면 (1) cloud proxy의 quota·감사·키 회전을 우회하고
 * (2) sandbox에 남은 키로 워크스페이스 격리를 무력화한다. 조용히 우회하지 않고 즉시 throw.
 *
 * @param {{ apiUrl?: string, apiKey?: string, messageId?: string }} [ctx]
 * @returns {{ url: string, headers: Record<string,string> }}
 */
export function resolveUpstream(ctx = {}) {
  const base = { 'content-type': 'application/json', 'accept': 'text/event-stream', 'anthropic-version': ANTHROPIC_VERSION }
  const directHeaders = () => ({ ...base, 'x-api-key': ctx.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '' })

  if (ctx.apiUrl) {
    return { url: ctx.apiUrl, headers: directHeaders() }
  }
  const proxyUrl = process.env.LLM_PROXY_URL
  if (proxyUrl) {
    return {
      url: proxyUrl,
      headers: {
        ...base,
        'authorization': `Bearer ${process.env.AGENT_RUNNER_TOKEN ?? ''}`,
        'x-workspace-id': process.env.WORKSPACE_ID ?? '',
        ...(ctx.messageId ? { 'x-daiops-message-id': String(ctx.messageId) } : {}),
      },
    }
  }
  const isProductionSandbox = process.env.NODE_ENV === 'production' || Boolean(process.env.WORKSPACE_ID)
  if (isProductionSandbox) {
    throw new Error(
      'resolveUpstream: LLM_PROXY_URL이 설정되지 않았습니다. 프로덕션 sandbox는 cloud proxy를 반드시 경유해야 합니다 ' +
      '(direct Anthropic fallback은 로컬·테스트 전용). deployer의 env 주입(LLM_PROXY_URL) 구성을 확인하세요.'
    )
  }
  return { url: ANTHROPIC_API_URL, headers: directHeaders() }
}

function isToolUseBlock(b) {
  return b && typeof b === 'object' && b.type === 'tool_use' && typeof b.id === 'string'
}
function isToolResultBlock(b) {
  return b && typeof b === 'object' && b.type === 'tool_result' && typeof b.tool_use_id === 'string'
}

/** content(문자열 또는 블록배열)를 블록배열로 승격. 빈 문자열은 빈 배열. */
function toBlockArray(c) {
  if (Array.isArray(c)) return c
  if (typeof c === 'string' && c.length > 0) return [{ type: 'text', text: c }]
  return []
}

/** 두 content 병합 — 둘 다 문자열이면 문자열, 하나라도 배열이면 배열로 이어붙인다. */
function mergeContent(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return a ? (b ? `${a}\n\n${b}` : a) : b
  }
  return [...toBlockArray(a), ...toBlockArray(b)]
}

/** 연속 동일 role 병합 + 선행 assistant 제거(첫 메시지는 user여야 한다). 배열 content도 병합. */
function mergeAndAlign(messages) {
  const out = []
  for (const m of messages) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user'
    const content = m?.content ?? ''
    if (out.length === 0 && role === 'assistant') continue
    const prev = out[out.length - 1]
    if (prev && prev.role === role) {
      prev.content = mergeContent(prev.content, content)
    } else {
      out.push({ role, content })
    }
  }
  return out
}

/**
 * orphan tool_use/tool_result 제거로 Anthropic 짝 불변식을 보장한다.
 * Anthropic은 매칭 tool_result 없는 tool_use(및 그 역)를 400으로 거부한다. 윈도우 경계에서
 * leading assistant(tool_use)가 잘리면 뒤따르는 tool_result가 orphan이 되는 등에 대응.
 * hermes convert_messages_to_anthropic / opencode·vellum pairing repair와 동일 취지.
 * content가 전부 orphan이라 비면 메시지 자체를 드롭한다.
 */
function repairToolPairing(messages) {
  const toolUseIds = new Set()
  const toolResultIds = new Set()
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (isToolUseBlock(b)) toolUseIds.add(b.id)
      if (isToolResultBlock(b)) toolResultIds.add(b.tool_use_id)
    }
  }
  const out = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      out.push(m)
      continue
    }
    const kept = m.content.filter((b) => {
      if (isToolResultBlock(b)) return toolUseIds.has(b.tool_use_id)
      if (isToolUseBlock(b)) return toolResultIds.has(b.id)
      return true
    })
    if (kept.length > 0) out.push({ role: m.role, content: kept })
  }
  return out
}

/**
 * 대화 시드 messages를 Anthropic Messages API 제약에 맞게 정규화한다.
 *  - role은 'user' | 'assistant'로 강제 (그 외는 'user' 취급)
 *  - 연속 동일 role은 하나로 병합 — API는 role 교대를 요구한다 (배열 content도 병합; ADR 18 Phase 3b)
 *  - 선행 assistant turn은 제거 — 첫 메시지는 user여야 한다
 *  - orphan tool_use/tool_result 제거 — dangling 짝은 API 400을 유발한다
 * 히스토리를 XML로 감싸지 않고 role별로 넘기는 게 목적 — 내부 태그(<turn>/<conversation_history> 등)
 * 프라이밍 제거의 핵심.
 *
 * merge/strip이 짝을 깨고(leading strip → orphan result), repair의 drop이 다시 인접/선행을 만들 수
 * 있어 안정될 때까지(최대 5회) 반복한다. 문자열-only 입력은 tool 블록이 없어 repair가 no-op이라
 * 기존 동작과 100% 동일하다.
 *
 * @param {Array<{role?:string, content?: unknown}>|undefined} raw
 * @returns {Array<{role:'user'|'assistant', content: string | Array<unknown>}>}
 */
export function normalizeConversationMessages(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {Array<{role:'user'|'assistant', content: string | Array<unknown>}>} */
  let msgs = raw.map((m) => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    content: /** @type {string | Array<unknown>} */ (m?.content ?? ''),
  }))
  for (let iter = 0; iter < 5; iter++) {
    const prevLen = msgs.length
    msgs = repairToolPairing(mergeAndAlign(msgs))
    // 안정(길이 불변) 시 종료 — 한 번 더 돌려도 변화 없음을 확인하고 멈춘다.
    if (msgs.length === prevLen) break
  }
  return msgs
}

/**
 * runAnthropicTurnManager — multi-turn loop 본체.
 *
 * 호출자(handler.js 또는 llm-wrapper.js swap 후)는 본 함수가 yield하는 SDK 호환 메시지를
 * 그대로 소비. message.type === 'assistant' / 'user' / 'result' 의 3종으로 정규화된다.
 *
 * @param {TurnManagerInput} input
 * @param {TurnManagerCtx} [ctx]
 * @yields {{ type: 'assistant', message: { content: ContentBlock[], usage: Usage } }
 *        | { type: 'user', message: { content: ToolResultBlock[] } }
 *        | { type: 'result', subtype: 'success' | 'error_max_turns' | 'error_context_overflow' }}
 */
export async function* runAnthropicTurnManager(input, ctx = {}) {
  const fetchFn = ctx.fetchFn ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new Error('runAnthropicTurnManager: fetch is not available; provide ctx.fetchFn')
  }
  // connect/헤더 타임아웃(ms) — 테스트·튜닝용 주입 허용(fetchFn 주입 철학과 동일). 미지정 시 모듈 기본값.
  const connectHeadersTimeoutMs = ctx.connectHeadersTimeoutMs ?? CONNECT_HEADERS_TIMEOUT_MS
  const upstream = resolveUpstream(ctx)
  const { signal } = ctx

  const maxTurns = input.options.maxTurns ?? 50
  // maxTokens 미지정 시 buildAnthropicRequest가 모델 ID로 자동 산출 (3.2 정규화).
  const maxTokens = input.options.maxTokens

  // 구조화 출력(AGENT-API-2/5): 설정 시 submit_structured_response로 최종 응답을 강제·검증한다.
  //  - structuredMode 'final_turn'(기본): open phase에서 도구를 자유롭게 쓰다가(thinking 활성) 모델이
  //    자연 종료(end_turn)하면 그때만 tool_choice를 1회 강제한다 → 도구 선사용 후 구조화가 가능.
  //  - structuredMode 'immediate': turn 0부터 강제(단발 변환 — 하위호환).
  //  검증 실패는 tool_result(is_error)로 돌려 자기수정 재시도하되 STRUCTURED_MAX_RETRIES로 캡.
  const structuredToolName = input.options.structuredToolName
  const structuredMode = input.options.structuredMode === 'immediate' ? 'immediate' : 'final_turn'
  const STRUCTURED_MAX_RETRIES = 3
  let structuredRetries = 0
  // forcing phase 진입 여부. immediate면 처음부터, final_turn이면 end_turn 감지 후 전환한다.
  // runTurnRequest가 이 값을 읽어 tool_choice 강제 여부를 매 turn 결정한다(closure 캡처).
  let structuredForcing = Boolean(structuredToolName) && structuredMode === 'immediate'

  // ── MCP 서버 자동 wiring (3.3) ────────────────────────────────────────
  // input.options.mcpServers가 있으면 registry 생성 → tools 머지 + runTool routing wrapper.
  // ctx.mcpRegistry가 주입돼 있으면 그것을 우선 사용 (테스트/외부 관리 케이스).
  const userRunTool = ctx.runTool
  let mcpRegistry = ctx.mcpRegistry ?? null
  let mcpRegistryOwned = false
  if (!mcpRegistry && Array.isArray(input.options.mcpServers) && input.options.mcpServers.length > 0) {
    mcpRegistry = await createMcpToolRegistry(input.options.mcpServers, {
      fetchFn: ctx.mcpFetchFn ?? fetchFn,
      signal,
    })
    mcpRegistryOwned = true
  }
  const merged = mergeTools(input.options.tools, mcpRegistry?.tools)
  const exposed = applyToolExposure(merged, input.options.toolExposure)
  const effectiveTools = exposed.tools
  const effectiveRunTool = mcpRegistry
    ? async (name, args, runCtx) => {
        if (isMcpToolName(name)) return mcpRegistry.runTool(name, args, runCtx)
        if (userRunTool) return userRunTool(name, args, runCtx)
        throw new Error(`runAnthropicTurnManager: no runTool for non-MCP tool '${name}'`)
      }
    : userRunTool

  // 대화 시드: role 분리 messages 배열(input.messages)을 우선. 미지정/빈 경우 단일 user prompt 폴백.
  const seeded = normalizeConversationMessages(input.messages)
  /** @type {Array<{role:'user'|'assistant', content: string | Array<unknown>}>} */
  const messages = seeded.length > 0
    ? seeded
    : [{ role: 'user', content: input.prompt ?? '' }]

  let turn = 0
  let thinkingSigRetryDone = false
  // A2-② 컨텍스트 압축: 직전 turn의 실제 input_tokens. 임계 초과 시 다음 turn 전 프루닝 트리거.
  let lastInputTokens = 0

  // 단일 turn의 LLM 호출(fetch + 전체 SSE 누적)을 1 단위로 묶는다. accumulateTurn이 스트림을 끝까지
  // 소비한 뒤에야 결과를 반환하므로 — turn-manager가 아직 아무것도 yield하지 않은 시점 — 이 함수 전체를
  // 재시도해도 SSE seq 중복/상태 오염이 없다 (retry-utils 원칙: 첫 yield 전까지만 재시도).
  const runTurnRequest = async () => {
    const buildBody = () => buildAnthropicRequest({
      model: input.options.model,
      systemPrompt: input.options.systemPrompt,
      messages,
      tools: effectiveTools,
      maxTokens,
      thinking: input.options.thinking,
      cacheControl: input.options.cacheControl,
      temperature: input.options.temperature,
      topP: input.options.topP,
      topK: input.options.topK,
      webTools: input.options.webTools,
      // final_turn 모드는 open phase에서 강제하지 않아(thinking 활성·도구 자유) 도구 선사용을 허용하고,
      // end_turn 감지 후 forcing phase에서만 tool_choice를 강제한다(AGENT-API-5).
      toolChoice: structuredForcing ? { type: 'tool', name: structuredToolName } : undefined,
    })
    let body = buildBody()
    let payload = JSON.stringify(body)

    // B2 발신 전 크기 가드: 직렬화 byte가 전송 예산 초과면 prune + 이미지 evict로 축소 후 재측정.
    // 그래도 초과면 무의미한 413 왕복 대신 조기 종료(classifyLlmError → payload_too_large → cloud 친화 안내).
    let payloadBytes = Buffer.byteLength(payload, 'utf8')
    if (payloadBytes > REQUEST_BYTE_BUDGET) {
      pruneOldToolResults(messages, {
        protectTailCount: PRUNE_PROTECT_TAIL,
        protectTailChars: PRUNE_PROTECT_TAIL_CHARS,
      })
      const over = payloadBytes - REQUEST_BYTE_BUDGET
      // base64 팽창 여유를 위해 초과분보다 조금 더 회수(over × 1.2).
      const { evicted, freedBytes } = evictImagesForBudget(messages, {
        bytesToFree: Math.ceil(over * 1.2),
        keepRecentImages: 1,
      })
      body = buildBody()
      payload = JSON.stringify(body)
      payloadBytes = Buffer.byteLength(payload, 'utf8')
      ctx.onOffload?.({ reason: 'payload_budget', evictedImages: evicted, freedBytes, payloadBytes })
      if (payloadBytes > REQUEST_BYTE_BUDGET) {
        throw Object.assign(
          new Error(
            `LLM 요청 payload 과대 413: 축소 후에도 ${payloadBytes} bytes > 예산 ${REQUEST_BYTE_BUDGET} ` +
            `(이미지 ${evicted}개 내림)`,
          ),
          { status: 413, body: 'payload exceeds transport budget after compaction' },
        )
      }
    }

    // 요청 전용 AbortController — 부모 signal(세션 abort)을 링크하되, stale watchdog이
    // *이 요청만* 끊을 수 있게 분리한다(부모를 직접 abort하면 세션 전체가 죽는다).
    const reqController = new AbortController()
    const onParentAbort = () => reqController.abort()
    if (signal) {
      if (signal.aborted) reqController.abort()
      else signal.addEventListener('abort', onParentAbort, { once: true })
    }
    // connect/헤더 수신 단계 타임아웃 — res(응답 헤더) 도착 전 hang 방어. res 도착 즉시 해제하므로
    // 스트리밍 body(streamWithStaleGuard 관할)에는 영향이 없다.
    let headersTimedOut = false
    // unref하지 않는다 — 이 타이머는 반드시 발화해야 하는 방어선이다. unref하면 fetch가 pending인데
    // 이벤트루프에 다른 활동이 없을 때(격리 실행/테스트) 타이머 발화 전에 루프가 idle 판정돼 abort가
    // 누락된다. 요청당 생성 + res 도착/에러 시 finally에서 즉시 clear하므로 프로세스 종료를 막지 않는다.
    const headersTimer = setTimeout(() => {
      headersTimedOut = true
      reqController.abort()
    }, connectHeadersTimeoutMs)
    try {
      let res
      try {
        res = await fetchFn(upstream.url, {
          method: 'POST',
          headers: upstream.headers,
          body: payload, // 위에서 직렬화·크기검증 완료 (재직렬화 회피)
          signal: reqController.signal,
        })
      } catch (err) {
        // 우리 headers 타임아웃으로 인한 abort는 retryable timeout(ETIMEDOUT)으로 재작성한다. 그대로 두면
        // AbortError가 classifyLlmError에서 non-retryable('aborted')로 분류돼 재시도되지 않는다(stale guard와 동일 정책).
        // 부모(세션) abort는 진짜 취소이므로 재작성하지 않고 그대로 전파.
        if (headersTimedOut && !signal?.aborted) {
          throw Object.assign(
            new Error(`Anthropic API connect/headers timeout (no response headers for ${connectHeadersTimeoutMs}ms)`),
            { code: 'ETIMEDOUT' },
          )
        }
        throw err
      } finally {
        clearTimeout(headersTimer)
      }
      if (!res.ok) {
        const errText = await safeReadText(res)
        // 413은 대개 upstream이 Anthropic이 아니라 LLM 프록시(Vercel) 전송 한도 초과 —
        // "Anthropic API"로 라벨하면 원인 오인. status로 분기해 정확히 표기(classifyLlmError는 status로 분류).
        const prefix = res.status === 413 ? 'LLM 요청 payload 과대' : 'Anthropic API'
        throw Object.assign(
          new Error(`${prefix} ${res.status}: ${errText.slice(0, 500)}`),
          { status: res.status, body: errText },
        )
      }
      if (!res.body) {
        throw new Error('Anthropic API returned empty body')
      }
      /** @type {{ content: ContentBlock[], usage: Usage, stop_reason: AnthropicStopReason | null } | null} */
      let at = null
      // stale watchdog으로 감싼 뒤 SSE 파싱. 업스트림이 STREAM_STALE_TIMEOUT_MS 동안 침묵하면
      // reqController.abort()로 연결을 끊고 retryable timeout을 throw → 상위 retry가 재시도.
      const guarded = streamWithStaleGuard(res.body, STREAM_STALE_TIMEOUT_MS, () => reqController.abort())
      // accumulateTurn 가 text_delta 도착마다 ctx.onPartialText 콜백을 호출하도록 forward.
      const accIter = accumulateTurn(parseAnthropicSSE(guarded), { onPartialText: ctx.onPartialText })
      for await (const out of accIter) {
        if (out.kind === 'error') {
          throw Object.assign(new Error(out.error.message || out.error.code), { code: out.error.code })
        }
        at = { content: out.content, usage: out.usage, stop_reason: out.stop_reason }
      }
      return at
    } finally {
      signal?.removeEventListener('abort', onParentAbort)
    }
  }

  try { // mcpRegistry close 보장
  while (true) {
    if (signal?.aborted) return

    // A2-② 컨텍스트 압축: 직전 turn input이 임계 초과면 보호 tail 밖 오래된 tool_result를 요약 치환.
    // 임계 미만이면 prefix 캐시 보존을 위해 무손. lastInputTokens=0으로 리셋해 다음 turn usage로
    // 재평가하기 전까지 재프루닝하지 않음(anti-thrashing). 프루닝 자체도 멱등(마커 가드).
    //
    // 우선순위4 프리엠티브 트리거: 직전 turn 실측(lastInputTokens)뿐 아니라 현재 messages의
    // tool_result char 추정으로도 트리거한다 — 이번 turn에 갑자기 부푼(실측이 아직 없는) 경우도
    // 넘치기 전에 정리. protect-tail은 개수가 아니라 char 예산 기준(PRUNE_PROTECT_TAIL_CHARS).
    const estimatedToolChars = estimateMessagesToolResultChars(messages)
    if (
      lastInputTokens > PRUNE_THRESHOLD_TOKENS ||
      estimatedToolChars > PRUNE_THRESHOLD_TOKENS * CHARS_PER_TOKEN
    ) {
      const pruned = pruneOldToolResults(messages, {
        protectTailCount: PRUNE_PROTECT_TAIL,
        protectTailChars: PRUNE_PROTECT_TAIL_CHARS,
      })
      if (pruned > 0) ctx.onPrune?.({ pruned })
      lastInputTokens = 0
    }

    /** @type {{ content: ContentBlock[], usage: Usage, stop_reason: AnthropicStopReason | null } | null} */
    let assistantTurn = null
    try {
      // turn 0은 호출자(handler)의 asyncIteratorWithFirstYieldRetry가 첫 yield 전까지 재시도를 소유하므로
      // 이중 재시도를 피해 그대로 호출. turn 1+는 여기서 per-turn 재시도 — 멀티턴 중간의 일시 실패
      // (rate_limit/overloaded/5xx/timeout)가 세션 전체 종료로 번지지 않게 한다 (P1).
      assistantTurn = turn === 0
        ? await runTurnRequest()
        : await withJitteredRetry(runTurnRequest, { signal, onRetry: ctx.onRetry, ...ctx.retryOpts })
    } catch (err) {
      // thinking 서명 무효 복구(1회 한정): 보존한 thinking 블록 서명이 컨텍스트 변형으로
      // 무효화되면 400. 모든 메시지에서 thinking 블록을 제거하고 같은 turn을 1회 재시도.
      if (!thinkingSigRetryDone && isThinkingSignatureError(err)) {
        thinkingSigRetryDone = true
        stripThinkingBlocks(messages)
        ctx.onRetry?.({ attempt: 1, delayMs: 0, reason: 'thinking_signature' })
        continue
      }
      throw err
    }
    if (signal?.aborted) return
    if (!assistantTurn) {
      // 스트림이 비어있음 — 정상 종료로 간주.
      yield { type: 'result', subtype: 'success' }
      return
    }

    yield {
      type: 'assistant',
      message: { content: assistantTurn.content, usage: assistantTurn.usage },
    }

    // A2-② — 다음 turn 프루닝 판정용. Anthropic usage.input_tokens(캐시 포함 실제 프롬프트 크기).
    lastInputTokens = assistantTurn.usage?.input_tokens ?? 0

    const stop = assistantTurn.stop_reason
    if (stop !== 'tool_use') {
      // 최종턴 전환(AGENT-API-5): final_turn 모드에서 도구 자유 사용 후 자연 종료(성공 subtype)가 나오면,
      // 방금 답변을 history에 넣고 구조화 제출을 지시한 뒤 forcing phase로 1회 전환한다. max_tokens/
      // context_overflow(비-success)는 절단이므로 전환하지 않고 그대로 error로 surface한다.
      // (open phase는 thinking 활성 + 도구 자유. forcing turn만 tool_choice 강제 → thinking 자동 off.)
      if (structuredToolName && !structuredForcing && stopReasonToResultSubtype(stop) === 'success') {
        structuredForcing = true
        // 빈 content(예: refusal)면 placeholder로 대체 — 빈 assistant content는 API가 거부하고,
        // 연속 user 메시지가 되면 role 교대 위반이 된다.
        messages.push({
          role: 'assistant',
          content: assistantTurn.content?.length ? assistantTurn.content : [{ type: 'text', text: '(완료)' }],
        })
        messages.push({ role: 'user', content: STRUCTURED_FINALIZE_PROMPT })
        turn++
        if (turn >= maxTurns) {
          yield { type: 'result', subtype: 'error_max_turns' }
          return
        }
        continue
      }
      yield { type: 'result', subtype: stopReasonToResultSubtype(stop) }
      return
    }

    // tool_use turn — canUseTool 게이트 + runTool 실행 + tool_result 합성
    const assistantBlocks = assistantTurn.content
    /** @type {ToolUseBlock[]} */
    const toolUses = /** @type {ToolUseBlock[]} */ (assistantBlocks.filter((b) => b.type === 'tool_use'))

    /** @type {ToolResultBlock[]} */
    const toolResults = []
    /** @type {ContentBlock[]} */
    const finalAssistantBlocks = []

    for (const block of assistantBlocks) {
      if (block.type !== 'tool_use') {
        finalAssistantBlocks.push(block)
        continue
      }
      if (signal?.aborted) return

      let effectiveInput = block.input
      let denied = false
      let denyMessage = ''
      if (ctx.canUseTool) {
        // 3번째 인자 `meta` — MCP 도구일 때만 출처 서버·어노테이션을 실어 보낸다(QA #105 축1).
        // 게이트는 이것 없이는 "외부 서버의 쓰기 도구"를 알 수 없다. 선택적 인자라 meta를 읽지
        // 않는 호출자(테스트·구 배선)는 종전과 완전히 같이 동작한다.
        const decision = await ctx.canUseTool(block.name, block.input, mcpRegistry?.getToolMeta?.(block.name))
        if (decision?.behavior === 'deny') {
          denied = true
          denyMessage = decision.message ?? `Tool '${block.name}' denied`
        } else if (decision?.behavior === 'allow' && decision.updatedInput !== undefined) {
          effectiveInput = decision.updatedInput
        }
      }

      finalAssistantBlocks.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: effectiveInput,
      })

      if (denied) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: denyMessage,
          is_error: true,
        })
        continue
      }

      if (!effectiveRunTool) {
        // 도구 실행기 미주입 — 에이전트는 결과 없이는 진행 불가. error로 surface.
        throw new Error(`runAnthropicTurnManager: runTool is required to execute tool '${block.name}'`)
      }
      try {
        const result = await effectiveRunTool(block.name, effectiveInput, { signal, toolUseId: block.id })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result?.content ?? '',
          ...(result?.is_error ? { is_error: true } : {}),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: msg,
          is_error: true,
        })
      }
    }

    if (toolUses.length === 0) {
      // stop_reason=tool_use인데 tool_use 블록이 없는 비정상 케이스 — 종료.
      yield { type: 'result', subtype: 'success' }
      return
    }

    // ── 구조화 출력(AGENT-API-2): submit_structured_response 결과 처리 ──
    // 검증 통과 → JSON 문자열을 최종 응답 텍스트로 yield하고 조기 종료(forced tool_choice라 계속 루프하면 무한).
    // 검증 실패 → 캡 이내면 tool_result(is_error)를 아래 공통 경로로 push해 다음 turn 자기수정 재시도.
    if (structuredToolName) {
      const structuredUse = toolUses.find((b) => b.name === structuredToolName)
      if (structuredUse) {
        const structuredResult = toolResults.find((r) => r.tool_use_id === structuredUse.id)
        if (structuredResult && !structuredResult.is_error) {
          const jsonText = String(structuredResult.content ?? '')
          // typed 신호(AGENT-API-5): 검증 통과한 최종 JSON을 파싱해 message에 실어 보낸다. handler가
          // 이를 structured_output SSE로 발신하고 원시 JSON을 text로는 노출하지 않는다(Option B).
          // 파싱 실패 시 structuredResult 필드를 생략 → handler가 기존처럼 text로 폴백한다.
          let parsed
          try { parsed = JSON.parse(jsonText) } catch { parsed = undefined }
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: jsonText }] },
            ...(parsed !== undefined ? { structuredResult: parsed } : {}),
          }
          yield { type: 'result', subtype: 'success' }
          return
        }
        structuredRetries++
        if (structuredRetries >= STRUCTURED_MAX_RETRIES) {
          // 캡 초과 — 무한 재시도를 막고 종료한다. 다만 버릴 것과 살릴 것을 가른다.
          //
          // 위반이 **경계(길이·개수·범위)뿐**이면 그 제출물은 구조가 맞고 의미상 온전하다.
          // 그것까지 버리면 "47자 길다"는 이유로 몇 분짜리 분석 결과 전체가 사라지고, 호출자는
          // 파싱 불가한 오류 산문을 받는다 — 경계 키워드를 집행하기 시작하면서 새로 생기는
          // 손실이다. 그래서 살려 보내고, 자르거나 되돌리는 판단은 소비자에게 남긴다.
          // 구조 위반(타입·필수 키·enum·미허용 키)은 종전대로 오류를 surface 한다.
          const acceptable =
            input.options.structuredAcceptOnCap?.(structuredUse.input) === true
          if (acceptable) {
            let jsonText = ''
            try { jsonText = JSON.stringify(structuredUse.input) } catch { jsonText = '' }
            if (jsonText) {
              yield {
                type: 'assistant',
                message: { content: [{ type: 'text', text: jsonText }] },
                structuredResult: structuredUse.input,
              }
              yield { type: 'result', subtype: 'success' }
              return
            }
          }
          yield {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: String(structuredResult?.content ?? 'structured output validation failed') },
              ],
            },
          }
          yield { type: 'result', subtype: 'success' }
          return
        }
      }
    }

    // 우선순위1: 이 turn의 tool_result 합계가 예산 초과면 큰 것부터 파일로 오프로드(프리뷰만 잔존).
    // push 이전에 mutate하므로 아래 messages와 yield(cloud DB 저장분) 모두 오프로드된 프리뷰로 일관.
    await enforceTurnResultBudget(toolResults, {
      budgetChars: resolveOffloadBudgetChars(input.options.model),
      onOffload: (info) => ctx.onOffload?.(info),
    })

    // 다음 turn에 push할 assistant + user(tool_result) 메시지
    messages.push({ role: 'assistant', content: finalAssistantBlocks })
    messages.push({ role: 'user', content: toolResults })

    yield { type: 'user', message: { content: toolResults } }

    turn++
    if (turn >= maxTurns) {
      yield { type: 'result', subtype: 'error_max_turns' }
      return
    }
  }
  } finally {
    if (mcpRegistryOwned && mcpRegistry) {
      try { await mcpRegistry.close() } catch { /* close 실패는 부수적 */ }
    }
  }
}

/**
 * tools 배열 두 개를 머지 — userTools 우선, 같은 이름은 user쪽이 win.
 *
 * @param {Array<{name:string}>=} userTools
 * @param {Array<{name:string}>=} mcpTools
 */
function mergeTools(userTools, mcpTools) {
  if (!mcpTools || mcpTools.length === 0) return userTools
  if (!userTools || userTools.length === 0) return mcpTools
  const seen = new Set(userTools.map((t) => t.name))
  return [...userTools, ...mcpTools.filter((t) => !seen.has(t.name))]
}

/** `mcp__<server>__<tool>` 에서 맨 이름만 — cloud 는 서버 접두어 없이 이름을 준다. */
function bareToolName(name) {
  if (!isMcpToolName(name)) return name
  const at = name.indexOf('__', 5)
  return name.slice(at + 2)
}

/**
 * 도구 노출 정책(A-1) 적용 — `alwaysLoadTools` 에 없는 **MCP 도구**에 `defer_loading` 을 붙인다.
 *
 * 지연된 도구는 스키마가 프리픽스에 실리지 않고, 모델이 필요할 때 `tool_search` 서버 도구로
 * 찾아 쓴다. 즉 **능력은 남고 토큰만 사라진다**(실측: 21종 전량 로드 11,407토큰 →
 * 2종 로드 + 19종 지연 1,904토큰).
 *
 * ## 러너는 판정하지 않는다 (ADR21)
 *
 * 여기서 하는 일은 집합 연산뿐이다. "왜 이 도구가 진입점인가"는 cloud
 * (`integrations/tool-exposure.ts`)가 정하고 이름 목록만 보낸다. 이 경계를 지키는 이유는
 * **고객이 등록한 외부 MCP 서버(ADR51)도 이 경로를 지나기 때문**이다 — 서버가 자기 노출
 * 등급을 스스로 주장하게 두면 안 된다(그래서 `mcp-client.js`의 `listTools`가 `_meta`를
 * 버리는 현재 동작도 그대로 둔다).
 *
 * ## 빌트인은 건드리지 않는다
 *
 * `Read`·`Bash` 같은 러너 빌트인은 지연 대상이 아니다. 스키마가 작고, 지시문이 절대 경로를
 * 주며 곧바로 부르게 되어 있어 지연시키면 매 턴 검색이 붙는다.
 *
 * @param {Array<any>} tools 머지된 전체 도구
 * @param {{alwaysLoadTools?: string[]}|undefined} exposure
 * @returns {{tools: Array<any>, deferred: number}}
 */
export function applyToolExposure(tools, exposure) {
  const always = Array.isArray(exposure?.alwaysLoadTools) ? exposure.alwaysLoadTools : null
  if (!always || !tools || tools.length === 0) return { tools, deferred: 0 }

  const allow = new Set(always)
  const marked = tools.map((t) =>
    isMcpToolName(t?.name) && !allow.has(bareToolName(t.name)) && !allow.has(t.name)
      ? { ...t, defer_loading: true }
      : t,
  )
  const deferred = marked.filter((t) => t.defer_loading).length

  // 전부 지연이면 Anthropic 이 400 을 준다("At least one tool must have defer_loading=false").
  // cloud 에도 같은 가드가 있지만 여기서도 막는다 — 목록이 갈리는 경우(외부 MCP 서버가
  // 이름을 바꿨다든지)에도 턴이 죽지 않아야 한다. 표시를 걷어내면 현행 동작(전량 로드)이다.
  if (deferred === marked.length) return { tools, deferred: 0 }

  return { tools: marked, deferred }
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
 * 400 응답이 thinking 블록 서명 무효 때문인지 판정.
 * Anthropic은 thinking 블록을 그 turn 전체 content에 대해 서명하므로, 컨텍스트 변형(cache 마커 삽입,
 * 세션 절단/병합 등)으로 서명이 깨지면 400을 반환한다.
 * @param {unknown} err
 */
export function isThinkingSignatureError(err) {
  const e = /** @type {{status?: number, body?: string, message?: string}} */ (err && typeof err === 'object' ? err : {})
  if (e.status !== 400) return false
  const text = String(e.body ?? e.message ?? '').toLowerCase()
  return text.includes('thinking') && text.includes('signature')
}

/**
 * 모든 assistant 메시지에서 thinking/redacted_thinking 블록을 제거 (in-place content 교체).
 * 서명 무효 복구용 — 다음 요청은 thinking 블록 없이 전송된다.
 * @param {Array<{role: string, content: unknown}>} messages
 */
export function stripThinkingBlocks(messages) {
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      m.content = m.content.filter(
        (b) => !(b && typeof b === 'object' && (/** @type {any} */ (b).type === 'thinking' || /** @type {any} */ (b).type === 'redacted_thinking')),
      )
    }
  }
}
