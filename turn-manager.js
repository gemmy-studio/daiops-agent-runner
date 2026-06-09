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

/** stale watchdog이 read race를 끊을 때 던지는 내부 sentinel. */
const STREAM_STALE = Symbol('stream-stale')

// ── web server tool ──────────────────────────────────────────────────────
// Anthropic server-side tool — 서버가 검색/페치를 직접 실행하고 server_tool_use +
// web_search_tool_result/web_fetch_tool_result 블록을 같은 응답에 인라인한다. 클라이언트
// 실행(runTool) 불필요. agent-runner는 anthropic 단일이라 webTools capability='server'를
// 상수로 반영 (TS src/lib/llm/adapters/anthropic-adapter.ts ANTHROPIC_CAPS.webTools와 정합).
const WEB_SEARCH_SERVER_TOOL = Object.freeze({ type: 'web_search_20250305', name: 'web_search' })
const WEB_FETCH_SERVER_TOOL = Object.freeze({ type: 'web_fetch_20250910', name: 'web_fetch' })

// server_tool_use 결과 블록 — accumulateTurn이 final content에서 버리지 않고 보존해야
// 멀티턴 메시지 히스토리가 유효하고 검색 결과가 노출된다.
const SERVER_RESULT_BLOCK_TYPES = new Set([
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
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
 * }} Usage
 *
 * @typedef {'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'model_context_window_exceeded'} AnthropicStopReason
 *
 * @typedef {{ name: string, description?: string, input_schema?: object }} ToolDef
 *
 * @typedef {Object} TurnManagerInput
 * @property {string} prompt — 첫 turn user message 텍스트
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
 *
 * @typedef {{ behavior: 'allow', updatedInput?: unknown } | { behavior: 'deny', message?: string }} CanUseToolResult
 *
 * @typedef {Object} TurnManagerCtx
 * @property {AbortSignal} [signal]
 * @property {string} [apiKey] — 미지정 시 process.env.ANTHROPIC_API_KEY
 * @property {string} [apiUrl] — 미지정 시 https://api.anthropic.com/v1/messages
 * @property {(toolName: string, input: unknown) => Promise<CanUseToolResult> | CanUseToolResult} [canUseTool]
 * @property {(toolName: string, input: unknown, ctx: { signal?: AbortSignal }) => Promise<{ content: string | Array<{type:'text', text:string}>, is_error?: boolean }>} [runTool]
 * @property {typeof globalThis.fetch} [fetchFn] — Anthropic Messages API용 테스트 주입.
 * @property {typeof globalThis.fetch} [mcpFetchFn] — MCP HTTP 호출용 테스트 주입 (미지정 시 fetchFn 재사용).
 * @property {{ tools: Array<any>, runTool: Function, close: () => Promise<void> }} [mcpRegistry] — 외부 관리 registry. 주입 시 mcpServers 자동 생성 스킵.
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
 * 호출자 약속: 입력 messages는 본 함수가 deep-clone하지 않으므로, in-place 수정에 동의해야
 * 한다 (turn-manager 내부에서 매 turn마다 새로 빌드한 messages만 전달).
 *
 * @param {{
 *   system: string | Array<{type:'text', text:string, cache_control?:object}> | undefined,
 *   messages: Array<{role:'user'|'assistant', content: string | Array<any>}>,
 *   ttl?: '5m' | '1h',
 * }} args
 * @returns {{
 *   system: string | Array<{type:'text', text:string, cache_control?:object}> | undefined,
 *   messages: Array<{role:'user'|'assistant', content: string | Array<any>}>,
 *   breakpoints: number,
 * }}
 */
export function applyPromptCacheControl(args) {
  const ttl = args.ttl ?? '1h'
  const marker = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }

  let system = args.system
  const messages = args.messages.map((m) => ({ ...m, content: cloneContent(m.content) }))

  let breakpoints = 0

  // 1) system 마커 — 항상 마지막 text 블록에 부착. string은 array of text block으로 승격.
  if (system) {
    if (typeof system === 'string') {
      system = [{ type: 'text', text: system, cache_control: marker }]
    } else if (Array.isArray(system) && system.length > 0) {
      // 마지막 dict-like 블록에 부착 (immutable copy를 만들지 않으면 호출자 system 객체 수정).
      system = system.map((blk, i) => (i === system.length - 1 ? { ...blk, cache_control: marker } : blk))
    }
    breakpoints++
  }

  // 2) 마지막 3개 non-system 메시지에 마커. messages는 system role을 포함하지 않는 가정.
  const remaining = 4 - breakpoints
  if (remaining > 0 && messages.length > 0) {
    const startIdx = Math.max(0, messages.length - remaining)
    for (let i = startIdx; i < messages.length; i++) {
      attachCacheMarker(messages[i], marker)
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
    // best-effort 정리 — await하지 않는다. stale로 끊긴 소스는 onStale의 abort로 read가 reject되며
    // *자체* 정리(releaseLock)되고, 정상 완료 소스는 이미 done까지 소진됐다. 여기서 return()을
    // await하면, 영원히 멈춘(never-settling) 소스에서 ETIMEDOUT 전파가 막혀 hang이 된다.
    try {
      const r = iterator.return?.()
      if (r && typeof r.then === 'function') r.then(() => {}, () => {})
    } catch { /* already done / not resumable */ }
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
 *    삽입 (system_and_3 전략). 기본 TTL은 '1h' (SDK 기본과 정합 — llm-wrapper 주석 참조).
 *  - 4.7+ 모델에서는 temperature/top_p/top_k가 비기본값이면 자동 제거.
 *
 * @param {{
 *   model: string,
 *   systemPrompt?: string | Array<{type:'text', text:string, cache_control?:object}>,
 *   messages: Array<{role:'user'|'assistant', content: string | Array<unknown>}>,
 *   tools?: ToolDef[],
 *   maxTokens?: number,
 *   thinking?: { effort?: 'low'|'medium'|'high'|'xhigh'|'max'|'minimal' } | false,
 *   cacheControl?: { ttl?: '5m' | '1h' } | false,
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
    const ttl = args.cacheControl?.ttl ?? '1h'
    const cached = applyPromptCacheControl({ system, messages, ttl })
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
  if (tools.length > 0) body.tools = tools

  // ── adaptive thinking 자동 wiring ───────────────────────────────────
  const thinkingCfg = buildThinkingOptions(args.model, args.thinking)
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
 * 프로덕션 가드(P0): 배포된 sandbox는 deployer가 `LLM_PROXY_URL`+`WORKSPACE_ID`를 주입하고
 * `ANTHROPIC_API_KEY`는 제거한다(Phase B 격리 목표). 따라서 프로덕션 신호
 * (`NODE_ENV==='production'` 또는 `WORKSPACE_ID` 존재)가 있는데 `LLM_PROXY_URL`이 비어 있으면
 * env 구성 오류다. 이때 direct fallback으로 흘러가면 (1) cloud proxy의 quota·감사·키 회전을 우회하고
 * (2) sandbox에 남은 키로 워크스페이스 격리를 무력화한다. 조용히 우회하지 않고 즉시 throw.
 *
 * @param {{ apiUrl?: string, apiKey?: string }} [ctx]
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
  const upstream = resolveUpstream(ctx)
  const { signal } = ctx

  const maxTurns = input.options.maxTurns ?? 50
  // maxTokens 미지정 시 buildAnthropicRequest가 모델 ID로 자동 산출 (3.2 정규화).
  const maxTokens = input.options.maxTokens

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
  const effectiveTools = mergeTools(input.options.tools, mcpRegistry?.tools)
  const effectiveRunTool = mcpRegistry
    ? async (name, args, runCtx) => {
        if (isMcpToolName(name)) return mcpRegistry.runTool(name, args, runCtx)
        if (userRunTool) return userRunTool(name, args, runCtx)
        throw new Error(`runAnthropicTurnManager: no runTool for non-MCP tool '${name}'`)
      }
    : userRunTool

  /** @type {Array<{role:'user'|'assistant', content: string | Array<unknown>}>} */
  const messages = [{ role: 'user', content: input.prompt }]

  let turn = 0
  let thinkingSigRetryDone = false

  // 단일 turn의 LLM 호출(fetch + 전체 SSE 누적)을 1 단위로 묶는다. accumulateTurn이 스트림을 끝까지
  // 소비한 뒤에야 결과를 반환하므로 — turn-manager가 아직 아무것도 yield하지 않은 시점 — 이 함수 전체를
  // 재시도해도 SSE seq 중복/상태 오염이 없다 (retry-utils 원칙: 첫 yield 전까지만 재시도).
  const runTurnRequest = async () => {
    const body = buildAnthropicRequest({
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
    })
    // 요청 전용 AbortController — 부모 signal(세션 abort)을 링크하되, stale watchdog이
    // *이 요청만* 끊을 수 있게 분리한다(부모를 직접 abort하면 세션 전체가 죽는다).
    const reqController = new AbortController()
    const onParentAbort = () => reqController.abort()
    if (signal) {
      if (signal.aborted) reqController.abort()
      else signal.addEventListener('abort', onParentAbort, { once: true })
    }
    try {
      const res = await fetchFn(upstream.url, {
        method: 'POST',
        headers: upstream.headers,
        body: JSON.stringify(body),
        signal: reqController.signal,
      })
      if (!res.ok) {
        const errText = await safeReadText(res)
        throw Object.assign(
          new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`),
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

    const stop = assistantTurn.stop_reason
    if (stop !== 'tool_use') {
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
        const decision = await ctx.canUseTool(block.name, block.input)
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
