/**
 * Agent Runner LLM Wrapper — Anthropic LLM stream을 LLMProvider.stream() 호환 layer로 격리.
 *
 * 책임:
 *  1. SDK 의존 제거 — `@anthropic-ai/claude-agent-sdk` 미사용. raw HTTP는 turn-manager로 격리.
 *  2. `sdkInput.options.canUseTool` + multi-turn loop은 turn-manager가 외부에서 운영.
 *  3. SDK_BUILTIN_TOOLS(Read/Edit/Glob/Grep/Bash/Write)는 자체 `tools/index.js`로 실행.
 *  4. yield 형식(`message.type === 'assistant'|'user'|'result'`)은 SDK 호환 — handler.js 무변경.
 *  5. ctx.emitLLMEvent(LLMEvent) hook도 유지 — sdkMessageToLLMEvents가 새 yield를 그대로 처리.
 *
 * 호출 인터페이스(handler.js 기준)는 *완전 동일*:
 *   for await (const message of runAnthropicSdkStream({ prompt, options }, { signal, emitLLMEvent }))
 *
 * options 호환 매핑 (handler.js → turn-manager):
 *   model, systemPrompt, allowedTools, abortController, canUseTool, mcpServers → 그대로
 *   cwd → ctx 경유로 tools/runBuiltinTool에 전달 (도구가 파일 IO 시 사용)
 *   maxTurns, permissionMode → turn-manager 자체 카운터 + canUseTool로 대체 (SDK 의미 보존)
 *   tools → allowedTools 기반 자동 wiring + options.tools에 사용자 정의 추가
 */

import { runAnthropicTurnManager } from './turn-manager.js'
import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES, runBuiltinTool, isBuiltinTool } from './tools/index.js'
import { isMcpToolName } from './mcp-client.js'

/**
 * @typedef {Object} TextDeltaEvent
 * @property {'text_delta'} type
 * @property {string} delta
 *
 * @typedef {Object} ToolUseStartEvent
 * @property {'tool_use_start'} type
 * @property {{ id: string, name: string }} tool
 *
 * @typedef {Object} ToolUseDeltaEvent
 * @property {'tool_use_delta'} type
 * @property {string} id
 * @property {string} input_delta
 *
 * @typedef {Object} ToolUseEndEvent
 * @property {'tool_use_end'} type
 * @property {string} id
 *
 * @typedef {Object} UsageEvent
 * @property {'usage'} type
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {number=} cache_read_tokens
 *
 * @typedef {Object} TurnEndEvent
 * @property {'turn_end'} type
 * @property {'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'} stop_reason
 *
 * @typedef {Object} ErrorEvent
 * @property {'error'} type
 * @property {{ code: string, message: string, retryable: boolean }} error
 *
 * @typedef {TextDeltaEvent | ToolUseStartEvent | ToolUseDeltaEvent | ToolUseEndEvent
 *          | UsageEvent | TurnEndEvent | ErrorEvent} LLMEvent
 *
 * @typedef {Object} SDKMessage
 * @property {'assistant' | 'user' | 'result'} type
 * @property {{ content?: any[], usage?: object }} [message]
 * @property {string} [subtype]
 */

/**
 * SDK 호환 메시지 1건을 LLMEvent[]로 변환.
 * turn-manager가 yield하는 메시지 shape도 SDK와 1:1 정합이라 본 함수는 변경 없이 동작.
 *
 *  - assistant text → text_delta (빈 텍스트는 skip)
 *  - tool_use → tool_use_start + tool_use_delta(input 통째 JSON) + tool_use_end
 *  - usage → 토큰 사용량 (cache_read 보존)
 *  - result → turn_end (subtype error_max_turns → max_tokens, 그 외 end_turn)
 *
 * @param {SDKMessage} message
 * @returns {LLMEvent[]}
 */
export function sdkMessageToLLMEvents(message) {
  /** @type {LLMEvent[]} */
  const events = []

  if (message?.type === 'assistant' && message.message?.content) {
    for (const block of message.message.content) {
      if (block && 'text' in block && typeof block.text === 'string' && block.text.length > 0) {
        events.push({ type: 'text_delta', delta: block.text })
      } else if (block && 'name' in block) {
        const id = typeof block.id === 'string' ? block.id : ''
        const name = String(block.name ?? '')
        events.push({ type: 'tool_use_start', tool: { id, name } })
        if (block.input !== undefined) {
          let inputDelta = ''
          try {
            inputDelta = JSON.stringify(block.input)
          } catch {
            inputDelta = ''
          }
          events.push({ type: 'tool_use_delta', id, input_delta: inputDelta })
        }
        events.push({ type: 'tool_use_end', id })
      }
    }
  }

  const usage = message?.message?.usage
  if (usage) {
    const input_tokens = usage.input_tokens ?? 0
    const output_tokens = usage.output_tokens ?? 0
    const cache_read_tokens = usage.cache_read_input_tokens
    if (input_tokens > 0 || output_tokens > 0 || (cache_read_tokens ?? 0) > 0) {
      const evt = { type: 'usage', input_tokens, output_tokens }
      if (cache_read_tokens !== undefined) evt.cache_read_tokens = cache_read_tokens
      events.push(evt)
    }
  }

  if (message?.type === 'result') {
    /** @type {'end_turn' | 'max_tokens'} */
    let stop_reason = 'end_turn'
    if (message.subtype === 'error_max_turns') stop_reason = 'max_tokens'
    events.push({ type: 'turn_end', stop_reason })
  }

  return events
}

/**
 * SDK_BUILTIN_TOOLS 이름 노출 — handler.js와 정합 유지용. handler.js의 SDK_BUILTIN_TOOLS와 동일.
 */
export const SDK_BUILTIN_TOOLS = BUILTIN_TOOL_NAMES

/**
 * Anthropic LLM stream + multi-turn loop + 자체 tool 실행 layer.
 *
 * 동작 (3.4 이후):
 *  - turn-manager로 위임 — raw HTTP fetch + SSE + canUseTool + multi-turn loop.
 *  - 빌트인 도구는 자체 runBuiltinTool로 실행, MCP 도구는 turn-manager 내부의 mcp-client registry로.
 *  - 매 yield된 SDK 호환 메시지마다 ctx.emitLLMEvent(LLMEvent)로 변환 emit.
 *  - ctx.signal.aborted 또는 sdkInput.options.abortController.signal.aborted 시 즉시 종료.
 *
 * @param {{ prompt: string, options: Object & { model?: string, systemPrompt?: string, allowedTools?: string[], tools?: Array<{name:string,description?:string,input_schema?:object}>, cwd?: string, maxTurns?: number, canUseTool?: Function, mcpServers?: Array<any>, abortController?: AbortController, thinking?: any, cacheControl?: any } }} sdkInput
 * @param {{
 *   signal?: AbortSignal,
 *   emitLLMEvent?: (event: LLMEvent) => void,
 *   fetchFn?: typeof globalThis.fetch,
 *   onPartialText?: (delta: string, index: number) => void,
 *   onToolProgress?: (p: { toolUseId?: string, elapsed_s: number, tail: string }) => void,
 * }} [ctx]
 * @yields {SDKMessage}
 */
export async function* runAnthropicSdkStream(sdkInput, ctx = {}) {
  const opts = sdkInput.options ?? {}

  // abortController.signal과 ctx.signal 결합 — 양쪽 모두 abort 가능.
  const externalSignal = ctx.signal
  const acSignal = opts.abortController?.signal
  let combinedSignal = externalSignal ?? acSignal
  if (externalSignal && acSignal && externalSignal !== acSignal) {
    const ac = new AbortController()
    const link = () => ac.abort()
    if (externalSignal.aborted || acSignal.aborted) ac.abort()
    else {
      externalSignal.addEventListener('abort', link, { once: true })
      acSignal.addEventListener('abort', link, { once: true })
    }
    combinedSignal = ac.signal
  }

  // 도구 wiring:
  //  - allowedTools 안에 빌트인 이름이 있으면 BUILTIN_TOOLS에서 해당 항목만 노출.
  //  - 사용자 정의 options.tools(있다면)는 추가로 머지.
  //  - mcpServers는 turn-manager 내부에서 자동 wiring (mcp-client registry).
  const allowedSet = new Set(Array.isArray(opts.allowedTools) ? opts.allowedTools : BUILTIN_TOOL_NAMES)
  const builtinSubset = BUILTIN_TOOLS.filter((t) => allowedSet.has(t.name))
  const userTools = Array.isArray(opts.tools) ? opts.tools : []
  const tools = mergeUnique(builtinSubset, userTools)

  // web server tool (5.4): allowedTools에 WebSearch/WebFetch가 있으면 Anthropic server tool로 등록.
  // agent-runner는 anthropic 단일이라 'server' 고정 (ANTHROPIC_CAPS.webTools와 정합). WebSearch/WebFetch는
  // BUILTIN_TOOLS에 없어 로컬 tool def로는 추가되지 않고 server tool로만 흐른다 (runTool 라우팅 없음).
  const webTools = {
    search: allowedSet.has('WebSearch') ? 'server' : 'none',
    fetch: allowedSet.has('WebFetch') ? 'server' : 'none',
  }

  // runTool: 빌트인은 자체 실행, MCP는 turn-manager가 routing(자기 registry에서 처리).
  const runTool = async (name, input, runCtx) => {
    // request_secret(Phase B): handler가 주입한 onRequestSecret 콜백으로 위임 — 결재 대기 + env 주입.
    // 값(평문)은 LLM에 노출되지 않고, 결과는 "$KEY 사용 가능" 핸들 텍스트만 반환된다.
    if (name === 'request_secret') {
      if (typeof ctx.onRequestSecret === 'function') return ctx.onRequestSecret(input)
      return { content: 'request_secret: 이 환경에서는 secret 요청이 지원되지 않습니다.', is_error: true }
    }
    if (isBuiltinTool(name)) {
      // Phase B 격리: 세션 secret을 자식 프로세스 env로만 주입(본체 process.env 미오염).
      // ctx.getToolEnv()가 {KEY:value} 맵을 반환하면 buildToolEnv(extra)로 Bash 등 자식에 머지된다.
      return runBuiltinTool(name, input, {
        cwd: opts.cwd,
        signal: runCtx?.signal ?? combinedSignal,
        env: typeof ctx.getToolEnv === 'function' ? ctx.getToolEnv() : undefined,
        // P3-a — 실행 중 tail 라이브 표시. 현재 실행 중인 tool_use_id를 붙여 handler가 SSE로 전달.
        onProgress: typeof ctx.onToolProgress === 'function'
          ? (p) => ctx.onToolProgress({ ...p, toolUseId: runCtx?.toolUseId })
          : undefined,
      })
    }
    // MCP 프리픽스도 아니고 빌트인도 아니면 turn-manager가 에러 처리.
    if (isMcpToolName(name)) {
      // 이 분기는 turn-manager가 자체 routing하므로 도달하지 않지만 안전 fallback.
      return { content: `Unrouted MCP tool: ${name}`, is_error: true }
    }
    return { content: `Unknown tool: ${name}`, is_error: true }
  }

  const turnManagerInput = {
    prompt: sdkInput.prompt,
    options: {
      model: opts.model ?? 'claude-sonnet-4-6',
      systemPrompt: opts.systemPrompt,
      tools,
      allowedTools: opts.allowedTools,
      maxTurns: opts.maxTurns,
      maxTokens: opts.maxTokens,
      thinking: opts.thinking,
      cacheControl: opts.cacheControl,
      mcpServers: opts.mcpServers,
      webTools,
    },
  }

  const turnManagerCtx = {
    signal: combinedSignal,
    canUseTool: opts.canUseTool,
    runTool,
    fetchFn: ctx.fetchFn,
    onPartialText: ctx.onPartialText,
  }

  for await (const message of runAnthropicTurnManager(turnManagerInput, turnManagerCtx)) {
    if (combinedSignal?.aborted) break
    if (ctx.emitLLMEvent) {
      try {
        for (const event of sdkMessageToLLMEvents(message)) ctx.emitLLMEvent(event)
      } catch {
        // LLMEvent emit 실패는 메시지 yield에 영향 없음.
      }
    }
    yield message
  }
}

/**
 * @param {Array<{name:string}>} a
 * @param {Array<{name:string}>} b
 */
function mergeUnique(a, b) {
  const seen = new Set(a.map((t) => t.name))
  return [...a, ...b.filter((t) => !seen.has(t.name))]
}
