import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseAnthropicSSE,
  accumulateTurn,
  buildAnthropicRequest,
  stopReasonToResultSubtype,
  runAnthropicTurnManager,
  ANTHROPIC_OUTPUT_LIMITS,
  ANTHROPIC_DEFAULT_OUTPUT_LIMIT,
  getAnthropicMaxOutput,
  supportsAdaptiveThinking,
  supportsXhighEffort,
  forbidsSamplingParams,
  applyPromptCacheControl,
  buildThinkingOptions,
  resolveUpstream,
  isThinkingSignatureError,
  stripThinkingBlocks,
  streamWithStaleGuard,
} from './turn-manager.js'
import { sdkMessageToLLMEvents } from './llm-wrapper.js'

/** SSE 이벤트 시퀀스를 라인 직렬화. */
function sse(events) {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
}

/** Uint8Array chunk를 yield하는 async iter. */
async function* asChunks(text, chunkSize = 64) {
  const enc = new TextEncoder()
  for (let i = 0; i < text.length; i += chunkSize) {
    yield enc.encode(text.slice(i, i + chunkSize))
  }
}

/** mock fetch — sse text를 body로 가진 Response 반환. */
function mockFetch(sseTexts) {
  const queue = Array.isArray(sseTexts) ? [...sseTexts] : [sseTexts]
  return async function fakeFetch(_url, _init) {
    const text = queue.shift() ?? ''
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        // 64자 단위로 chunked emit — chunk 경계가 SSE 블록 중간에 떨어지는 케이스 검증.
        for (let i = 0; i < text.length; i += 37) {
          controller.enqueue(enc.encode(text.slice(i, i + 37)))
        }
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

// ── SSE 파서 ──────────────────────────────────────────────────────────

describe('parseAnthropicSSE', () => {
  it('event + data 한 블록 파싱', async () => {
    const text = sse([{ event: 'message_start', data: { type: 'message_start', message: { id: 'm1' } } }])
    const out = []
    for await (const ev of parseAnthropicSSE(asChunks(text))) out.push(ev)
    assert.equal(out.length, 1)
    assert.equal(out[0].event, 'message_start')
    assert.equal(out[0].data.message.id, 'm1')
  })

  it('여러 블록이 chunk 경계를 가로질러도 누락 없음', async () => {
    const text = sse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ])
    const out = []
    for await (const ev of parseAnthropicSSE(asChunks(text, 17))) out.push(ev)
    assert.equal(out.length, 6)
    assert.equal(out[0].event, 'message_start')
    assert.equal(out[5].event, 'message_stop')
  })

  it('잘못된 data JSON은 skip', async () => {
    const text =
      'event: bad\ndata: not-json\n\n' +
      sse([{ event: 'message_stop', data: { type: 'message_stop' } }])
    const out = []
    for await (const ev of parseAnthropicSSE(asChunks(text))) out.push(ev)
    assert.equal(out.length, 1)
    assert.equal(out[0].event, 'message_stop')
  })

  it('ReadableStream도 그대로 받음', async () => {
    const text = sse([{ event: 'message_stop', data: { type: 'message_stop' } }])
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(text))
        c.close()
      },
    })
    const out = []
    for await (const ev of parseAnthropicSSE(stream)) out.push(ev)
    assert.equal(out.length, 1)
  })
})

// ── accumulateTurn ────────────────────────────────────────────────────

describe('accumulateTurn', () => {
  /** Anthropic SSE 시퀀스 헬퍼: assistant text + tool_use 패턴. */
  function buildEvents(opts) {
    const ev = [
      { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
    ]
    let idx = 0
    if (opts.text) {
      ev.push({ event: 'content_block_start', data: { index: idx, content_block: { type: 'text', text: '' } } })
      ev.push({ event: 'content_block_delta', data: { index: idx, delta: { type: 'text_delta', text: opts.text } } })
      ev.push({ event: 'content_block_stop', data: { index: idx } })
      idx++
    }
    for (const tu of (opts.toolUses ?? [])) {
      ev.push({ event: 'content_block_start', data: { index: idx, content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} } } })
      const jsonStr = JSON.stringify(tu.input)
      // partial_json delta를 절반으로 쪼개 누적 검증
      const mid = Math.floor(jsonStr.length / 2)
      ev.push({ event: 'content_block_delta', data: { index: idx, delta: { type: 'input_json_delta', partial_json: jsonStr.slice(0, mid) } } })
      ev.push({ event: 'content_block_delta', data: { index: idx, delta: { type: 'input_json_delta', partial_json: jsonStr.slice(mid) } } })
      ev.push({ event: 'content_block_stop', data: { index: idx } })
      idx++
    }
    ev.push({ event: 'message_delta', data: { delta: { stop_reason: opts.stop_reason }, usage: { output_tokens: opts.output_tokens ?? 20 } } })
    ev.push({ event: 'message_stop', data: {} })
    return ev
  }

  async function* iter(events) { for (const e of events) yield e }

  it('text 블록 누적', async () => {
    const events = buildEvents({ text: 'Hello', stop_reason: 'end_turn' })
    const out = []
    for await (const o of accumulateTurn(iter(events))) out.push(o)
    assert.equal(out.length, 1)
    assert.equal(out[0].kind, 'assistant')
    assert.deepEqual(out[0].content, [{ type: 'text', text: 'Hello' }])
    assert.equal(out[0].stop_reason, 'end_turn')
    assert.equal(out[0].usage.input_tokens, 10)
    assert.equal(out[0].usage.output_tokens, 20)
  })

  it('tool_use input partial_json 누적 → JSON.parse', async () => {
    const events = buildEvents({
      toolUses: [{ id: 'tu_1', name: 'Read', input: { path: 'foo.ts' } }],
      stop_reason: 'tool_use',
    })
    const out = []
    for await (const o of accumulateTurn(iter(events))) out.push(o)
    assert.equal(out[0].content.length, 1)
    assert.deepEqual(out[0].content[0], { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'foo.ts' } })
    assert.equal(out[0].stop_reason, 'tool_use')
  })

  it('text + tool_use 혼합', async () => {
    const events = buildEvents({
      text: 'Reading',
      toolUses: [{ id: 'tu_1', name: 'Read', input: { path: 'a' } }],
      stop_reason: 'tool_use',
    })
    const out = []
    for await (const o of accumulateTurn(iter(events))) out.push(o)
    assert.equal(out[0].content.length, 2)
    assert.equal(out[0].content[0].type, 'text')
    assert.equal(out[0].content[1].type, 'tool_use')
  })

  it('error 이벤트 → error kind', async () => {
    async function* errIter() {
      yield { event: 'error', data: { error: { type: 'overloaded_error', message: 'busy' } } }
    }
    const out = []
    for await (const o of accumulateTurn(errIter())) out.push(o)
    assert.equal(out[0].kind, 'error')
    assert.equal(out[0].error.code, 'overloaded_error')
  })

  it('cache_read/creation_input_tokens 보존', async () => {
    async function* ev() {
      yield { event: 'message_start', data: { message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 30 } } } }
      yield { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } }
      yield { event: 'message_stop', data: {} }
    }
    const out = []
    for await (const o of accumulateTurn(ev())) out.push(o)
    assert.equal(out[0].usage.cache_read_input_tokens, 50)
    assert.equal(out[0].usage.cache_creation_input_tokens, 30)
  })

  it('opts.onPartialText — text_delta 도착마다 호출, delta/index 정확', async () => {
    // 한 turn 안에 두 개의 text 블록이 각각 두 번의 text_delta 로 흐름.
    const events = [
      { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'Hello ' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'world' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'content_block_start', data: { index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 1, delta: { type: 'text_delta', text: '!' } } },
      { event: 'content_block_stop', data: { index: 1 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
      { event: 'message_stop', data: {} },
    ]
    const calls = []
    const out = []
    for await (const o of accumulateTurn(iter(events), { onPartialText: (delta, index) => calls.push({ delta, index }) })) {
      out.push(o)
    }
    // 콜백 호출 횟수 = text_delta 이벤트 수
    assert.equal(calls.length, 3)
    assert.deepEqual(calls, [
      { delta: 'Hello ', index: 0 },
      { delta: 'world', index: 0 },
      { delta: '!', index: 1 },
    ])
    // 누적 결과(content)도 정상 보존 — 콜백이 yield 흐름에 영향 없음
    assert.equal(out.length, 1)
    assert.deepEqual(out[0].content, [
      { type: 'text', text: 'Hello world' },
      { type: 'text', text: '!' },
    ])
  })

  it('opts.onPartialText — 빈 text_delta는 콜백 미호출 (no-op delta 가드)', async () => {
    const events = [
      { event: 'message_start', data: { message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
      // 빈 문자열 text_delta — 콜백 호출 안 됨
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'x' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
      { event: 'message_stop', data: {} },
    ]
    const calls = []
    for await (const _ of accumulateTurn(iter(events), { onPartialText: (delta) => calls.push(delta) })) { /* drain */ }
    assert.deepEqual(calls, ['x'])
  })

  it('opts.onPartialText — 콜백 throw는 본 흐름에 영향 없음', async () => {
    const events = buildEvents({ text: 'ok', stop_reason: 'end_turn' })
    const out = []
    for await (const o of accumulateTurn(iter(events), { onPartialText: () => { throw new Error('boom') } })) {
      out.push(o)
    }
    // 콜백이 throw 해도 final assistant yield 정상
    assert.equal(out.length, 1)
    assert.equal(out[0].kind, 'assistant')
    assert.deepEqual(out[0].content, [{ type: 'text', text: 'ok' }])
  })
})

// ── stopReasonToResultSubtype ─────────────────────────────────────────

describe('stopReasonToResultSubtype', () => {
  it('end_turn → success', () => assert.equal(stopReasonToResultSubtype('end_turn'), 'success'))
  it('stop_sequence → success', () => assert.equal(stopReasonToResultSubtype('stop_sequence'), 'success'))
  it('refusal → success', () => assert.equal(stopReasonToResultSubtype('refusal'), 'success'))
  it('max_tokens → error_max_turns', () => assert.equal(stopReasonToResultSubtype('max_tokens'), 'error_max_turns'))
  it('model_context_window_exceeded → error_context_overflow (#14, success로 두지 않음)', () =>
    assert.equal(stopReasonToResultSubtype('model_context_window_exceeded'), 'error_context_overflow'))
  it('null → success', () => assert.equal(stopReasonToResultSubtype(null), 'success'))
})

// ── buildAnthropicRequest ─────────────────────────────────────────────

describe('buildAnthropicRequest (3.1 기본 직렬화)', () => {
  it('기본 필드 직렬화 — cacheControl:false로 raw shape 검증', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: false,
      cacheControl: false,
    })
    assert.equal(body.model, 'claude-sonnet-4-6')
    assert.equal(body.stream, true)
    assert.equal(body.max_tokens, 64_000) // 모델 테이블 자동 산출 (3.2)
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
    assert.equal(body.system, undefined)
    assert.equal(body.tools, undefined)
    assert.equal(body.thinking, undefined)
  })

  it('systemPrompt + tools + maxTokens 옵션 반영 — cacheControl:false', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are X',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      maxTokens: 8192,
      cacheControl: false,
      thinking: false,
    })
    assert.equal(body.system, 'You are X')
    assert.equal(body.max_tokens, 8192)
    assert.equal(body.tools.length, 1)
  })
})

// ── buildAnthropicRequest webTools ───────────────────────────────────

describe('buildAnthropicRequest — web server tool 등록', () => {
  it('webTools.search=server → tools[]에 web_search_20250305 추가', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      webTools: { search: 'server', fetch: 'none' },
      cacheControl: false,
      thinking: false,
    })
    assert.equal(body.tools.length, 1)
    assert.deepEqual(body.tools[0], { type: 'web_search_20250305', name: 'web_search' })
  })

  it('search+fetch 둘 다 server → 2종 추가, user tool과 공존', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      webTools: { search: 'server', fetch: 'server' },
      cacheControl: false,
      thinking: false,
    })
    assert.equal(body.tools.length, 3)
    assert.equal(body.tools[0].name, 'Read')
    assert.deepEqual(body.tools[1], { type: 'web_search_20250305', name: 'web_search' })
    assert.deepEqual(body.tools[2], { type: 'web_fetch_20250910', name: 'web_fetch' })
  })

  it('webTools none/미지정 → server tool 미추가', () => {
    const noWeb = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      webTools: { search: 'none', fetch: 'none' },
      cacheControl: false,
      thinking: false,
    })
    assert.equal(noWeb.tools, undefined)
    const undef = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      cacheControl: false,
      thinking: false,
    })
    assert.equal(undef.tools, undefined)
  })
})

// ── resolveUpstream (5.5 base URL + auth 헤더 swap) ────────────────────

describe('resolveUpstream', () => {
  const saved = {}
  function setEnv(k, v) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  function restore() {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }

  it('LLM_PROXY_URL 설정 시 proxy URL + Bearer AGENT_RUNNER_TOKEN + x-workspace-id', () => {
    setEnv('LLM_PROXY_URL', 'https://cloud.example/api/internal/llm/messages')
    setEnv('AGENT_RUNNER_TOKEN', 'ws-token-123')
    setEnv('WORKSPACE_ID', 'ws-abc')
    setEnv('ANTHROPIC_API_KEY', 'sk-should-not-be-used')
    try {
      const r = resolveUpstream({})
      assert.equal(r.url, 'https://cloud.example/api/internal/llm/messages')
      assert.equal(r.headers['authorization'], 'Bearer ws-token-123')
      assert.equal(r.headers['x-workspace-id'], 'ws-abc')
      // proxy 모드는 x-api-key를 절대 보내지 않음 (sandbox에 키 부재 보장)
      assert.equal(r.headers['x-api-key'], undefined)
    } finally {
      restore()
    }
  })

  it('LLM_PROXY_URL 미설정 + 비프로덕션 시 direct Anthropic (x-api-key)', () => {
    setEnv('LLM_PROXY_URL', undefined)
    setEnv('NODE_ENV', 'test')
    setEnv('WORKSPACE_ID', undefined)
    setEnv('ANTHROPIC_API_KEY', 'sk-direct')
    try {
      const r = resolveUpstream({})
      assert.equal(r.url, 'https://api.anthropic.com/v1/messages')
      assert.equal(r.headers['x-api-key'], 'sk-direct')
      assert.equal(r.headers['authorization'], undefined)
    } finally {
      restore()
    }
  })

  it('P0 가드: 프로덕션(NODE_ENV)에서 LLM_PROXY_URL 미설정 시 throw', () => {
    setEnv('LLM_PROXY_URL', undefined)
    setEnv('NODE_ENV', 'production')
    setEnv('WORKSPACE_ID', undefined)
    setEnv('ANTHROPIC_API_KEY', 'sk-should-not-leak')
    try {
      assert.throws(() => resolveUpstream({}), /LLM_PROXY_URL이 설정되지 않았습니다/)
    } finally {
      restore()
    }
  })

  it('P0 가드: WORKSPACE_ID 주입된 sandbox에서 LLM_PROXY_URL 미설정 시 throw', () => {
    setEnv('LLM_PROXY_URL', undefined)
    setEnv('NODE_ENV', 'test')
    setEnv('WORKSPACE_ID', 'ws-deployed')
    setEnv('ANTHROPIC_API_KEY', 'sk-should-not-leak')
    try {
      assert.throws(() => resolveUpstream({}), /cloud proxy를 반드시 경유/)
    } finally {
      restore()
    }
  })

  it('P0 가드: ctx.apiUrl 주입은 프로덕션에서도 우선 (테스트·외부 제어 경로 보존)', () => {
    setEnv('LLM_PROXY_URL', undefined)
    setEnv('NODE_ENV', 'production')
    setEnv('WORKSPACE_ID', 'ws-deployed')
    try {
      const r = resolveUpstream({ apiUrl: 'https://injected/url', apiKey: 'sk-inj' })
      assert.equal(r.url, 'https://injected/url')
      assert.equal(r.headers['x-api-key'], 'sk-inj')
    } finally {
      restore()
    }
  })

  it('ctx.apiUrl 주입이 proxy보다 우선 (테스트 경로)', () => {
    setEnv('LLM_PROXY_URL', 'https://cloud.example/proxy')
    try {
      const r = resolveUpstream({ apiUrl: 'https://injected/url', apiKey: 'sk-inj' })
      assert.equal(r.url, 'https://injected/url')
      assert.equal(r.headers['x-api-key'], 'sk-inj')
    } finally {
      restore()
    }
  })
})

// ── accumulateTurn server tool 블록 보존 (5.4) ─────────────────────────

describe('accumulateTurn — server tool 블록 보존', () => {
  async function* iter(events) { for (const e of events) yield e }

  it('server_tool_use input 누적 + web_search_tool_result 패스스루', async () => {
    const searchInput = { query: 'daiops pricing' }
    const jsonStr = JSON.stringify(searchInput)
    const resultBlock = {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtu_1',
      content: [{ type: 'web_search_result', title: 'X', url: 'https://x', encrypted_content: 'e' }],
    }
    const events = [
      { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'server_tool_use', id: 'srvtu_1', name: 'web_search', input: {} } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'input_json_delta', partial_json: jsonStr } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'content_block_start', data: { index: 1, content_block: resultBlock } },
      { event: 'content_block_stop', data: { index: 1 } },
      { event: 'content_block_start', data: { index: 2, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 2, delta: { type: 'text_delta', text: 'Found it.' } } },
      { event: 'content_block_stop', data: { index: 2 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } } },
      { event: 'message_stop', data: {} },
    ]
    const out = []
    for await (const o of accumulateTurn(iter(events))) out.push(o)
    assert.equal(out.length, 1)
    const content = out[0].content
    assert.equal(content.length, 3)
    assert.deepEqual(content[0], { type: 'server_tool_use', id: 'srvtu_1', name: 'web_search', input: searchInput })
    assert.deepEqual(content[1], resultBlock)
    assert.deepEqual(content[2], { type: 'text', text: 'Found it.' })
    // stop_reason=end_turn (server tool은 같은 응답에서 resolve)
    assert.equal(out[0].stop_reason, 'end_turn')
  })

  it('서명 없는 thinking 블록은 제외 (P1 보존은 서명 있는 블록만)', async () => {
    const events = [
      { event: 'message_start', data: { message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'thinking' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'content_block_start', data: { index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 1, delta: { type: 'text_delta', text: 'hi' } } },
      { event: 'content_block_stop', data: { index: 1 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
      { event: 'message_stop', data: {} },
    ]
    const out = []
    for await (const o of accumulateTurn(iter(events))) out.push(o)
    assert.deepEqual(out[0].content, [{ type: 'text', text: 'hi' }])
  })
})

// ── runAnthropicTurnManager ────────────────────────────────────────────

describe('runAnthropicTurnManager — 기본 round-trip', () => {
  it('단일 turn end_turn → assistant + result(success)', async () => {
    const ssePayload = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'Hi' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
      { event: 'message_stop', data: {} },
    ])
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'hello', options: { model: 'claude-sonnet-4-6' } },
      { fetchFn: mockFetch(ssePayload), apiKey: 'sk-test' },
    )) {
      yielded.push(m)
    }
    assert.equal(yielded.length, 2)
    assert.equal(yielded[0].type, 'assistant')
    assert.deepEqual(yielded[0].message.content, [{ type: 'text', text: 'Hi' }])
    assert.equal(yielded[1].type, 'result')
    assert.equal(yielded[1].subtype, 'success')
  })

  it('ctx.onPartialText — text_delta SSE 도착마다 forward 호출', async () => {
    // 한 turn 안에서 토큰 단위 SSE delta 3건 → 콜백 3회 호출.
    const ssePayload = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'Hel' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'lo ' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: '👋' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
      { event: 'message_stop', data: {} },
    ])
    const partials = []
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6' } },
      {
        fetchFn: mockFetch(ssePayload),
        apiKey: 'sk-test',
        onPartialText: (delta, index) => partials.push({ delta, index }),
      },
    )) {
      yielded.push(m)
    }
    assert.deepEqual(partials, [
      { delta: 'Hel', index: 0 },
      { delta: 'lo ', index: 0 },
      { delta: '👋', index: 0 },
    ])
    // final assistant 누적 정합 — 모든 delta 가 누적된 형태로 yield.
    assert.equal(yielded[0].type, 'assistant')
    assert.deepEqual(yielded[0].message.content, [{ type: 'text', text: 'Hello 👋' }])
  })

  it('ctx.onPartialText 미주입 — text_delta 가 와도 정상 동작 (콜백 optional)', async () => {
    const ssePayload = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'ok' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
      { event: 'message_stop', data: {} },
    ])
    const yielded = []
    // onPartialText 미주입 — 콜백 없이도 정상 처리.
    for await (const m of runAnthropicTurnManager(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6' } },
      { fetchFn: mockFetch(ssePayload), apiKey: 'sk-test' },
    )) {
      yielded.push(m)
    }
    assert.equal(yielded[0].type, 'assistant')
    assert.deepEqual(yielded[0].message.content, [{ type: 'text', text: 'ok' }])
  })

  it('max_tokens stop_reason → result(error_max_turns)', async () => {
    const ssePayload = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'partial' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } } },
      { event: 'message_stop', data: {} },
    ])
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6' } },
      { fetchFn: mockFetch(ssePayload), apiKey: 'sk-test' },
    )) {
      yielded.push(m)
    }
    assert.equal(yielded[yielded.length - 1].subtype, 'error_max_turns')
  })

  it('model_context_window_exceeded stop_reason → result(error_context_overflow) (#14)', async () => {
    const ssePayload = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 200000, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'truncated' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'model_context_window_exceeded' }, usage: { output_tokens: 100 } } },
      { event: 'message_stop', data: {} },
    ])
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6' } },
      { fetchFn: mockFetch(ssePayload), apiKey: 'sk-test' },
    )) {
      yielded.push(m)
    }
    // overflow를 success로 두면 절단을 완료로 오인 — 반드시 별도 error subtype.
    assert.equal(yielded[yielded.length - 1].subtype, 'error_context_overflow')
  })

  it('API 4xx → throw', async () => {
    const fakeFetch = async () => new Response('rate limited', { status: 429 })
    await assert.rejects(
      (async () => {
        for await (const _ of runAnthropicTurnManager(
          { prompt: 'hi', options: { model: 'x' } },
          { fetchFn: fakeFetch, apiKey: 'k' },
        )) { /* consume */ }
      })(),
      /429/,
    )
  })
})

describe('runAnthropicTurnManager — multi-turn (tool_use)', () => {
  /** Turn 1: tool_use 응답 SSE. Turn 2: 최종 텍스트 응답 SSE. */
  function buildToolUseConvo({ toolName = 'Read', input = { path: 'a.ts' }, finalText = 'Done' } = {}) {
    const turn1 = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: toolName, input: {} } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } } },
      { event: 'message_stop', data: {} },
    ])
    const turn2 = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 50, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: finalText } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
      { event: 'message_stop', data: {} },
    ])
    return [turn1, turn2]
  }

  it('canUseTool allow + runTool 실행 → user 메시지에 tool_result + 다음 turn assistant + result', async () => {
    const calls = { canUse: 0, run: 0 }
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'read foo', options: { model: 'claude-sonnet-4-6' } },
      {
        fetchFn: mockFetch(buildToolUseConvo()),
        apiKey: 'sk-test',
        canUseTool: async () => { calls.canUse++; return { behavior: 'allow' } },
        runTool: async (name, input) => {
          calls.run++
          assert.equal(name, 'Read')
          assert.deepEqual(input, { path: 'a.ts' })
          return { content: 'file contents' }
        },
      },
    )) {
      yielded.push(m)
    }

    assert.equal(calls.canUse, 1)
    assert.equal(calls.run, 1)
    assert.equal(yielded.length, 4) // assistant(tool_use) + user(tool_result) + assistant(text) + result
    assert.equal(yielded[0].type, 'assistant')
    assert.equal(yielded[0].message.content[0].type, 'tool_use')
    assert.equal(yielded[1].type, 'user')
    assert.equal(yielded[1].message.content[0].type, 'tool_result')
    assert.equal(yielded[1].message.content[0].tool_use_id, 'tu_1')
    assert.equal(yielded[1].message.content[0].content, 'file contents')
    assert.equal(yielded[2].type, 'assistant')
    assert.equal(yielded[2].message.content[0].text, 'Done')
    assert.equal(yielded[3].type, 'result')
    assert.equal(yielded[3].subtype, 'success')
  })

  it('canUseTool deny → tool_result is_error (runTool 미호출), 다음 turn 계속', async () => {
    const calls = { run: 0 }
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'do', options: { model: 'm' } },
      {
        fetchFn: mockFetch(buildToolUseConvo()),
        apiKey: 'k',
        canUseTool: async () => ({ behavior: 'deny', message: 'blocked by policy' }),
        runTool: async () => { calls.run++; return { content: 'never' } },
      },
    )) {
      yielded.push(m)
    }
    assert.equal(calls.run, 0)
    const userMsg = yielded.find((m) => m.type === 'user')
    assert.equal(userMsg.message.content[0].is_error, true)
    assert.equal(userMsg.message.content[0].content, 'blocked by policy')
  })

  it('canUseTool allow + updatedInput → runTool에 변형된 input 전달', async () => {
    let runInput = null
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'do', options: { model: 'm' } },
      {
        fetchFn: mockFetch(buildToolUseConvo({ input: { path: '/tmp/x' } })),
        apiKey: 'k',
        canUseTool: async () => ({ behavior: 'allow', updatedInput: { path: '/tmp/x-fixed' } }),
        runTool: async (_name, input) => { runInput = input; return { content: 'ok' } },
      },
    )) {
      yielded.push(m)
    }
    assert.deepEqual(runInput, { path: '/tmp/x-fixed' })
    // SDK 호환: yield된 assistant 블록은 LLM 원본 input을 유지 (handler.js의 tool_use SSE도 원본 표시).
    // updatedInput은 runTool 호출과 다음 turn 메시지 히스토리에만 반영된다.
    const assistantToolUse = yielded[0].message.content.find((b) => b.type === 'tool_use')
    assert.deepEqual(assistantToolUse.input, { path: '/tmp/x' })
  })

  it('runTool throw → tool_result is_error로 캡처, 다음 turn 계속', async () => {
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'do', options: { model: 'm' } },
      {
        fetchFn: mockFetch(buildToolUseConvo()),
        apiKey: 'k',
        canUseTool: async () => ({ behavior: 'allow' }),
        runTool: async () => { throw new Error('disk full') },
      },
    )) {
      yielded.push(m)
    }
    const userMsg = yielded.find((m) => m.type === 'user')
    assert.equal(userMsg.message.content[0].is_error, true)
    assert.equal(userMsg.message.content[0].content, 'disk full')
  })

  it('runTool 미주입 시 throw (canUseTool allow이지만 실행기 없음)', async () => {
    await assert.rejects(
      (async () => {
        for await (const _ of runAnthropicTurnManager(
          { prompt: 'do', options: { model: 'm' } },
          { fetchFn: mockFetch(buildToolUseConvo()), apiKey: 'k', canUseTool: async () => ({ behavior: 'allow' }) },
        )) { /* consume */ }
      })(),
      /runTool is required/,
    )
  })

  it('maxTurns 도달 시 result(error_max_turns) — 무한 tool_use loop 방어', async () => {
    // 매 turn마다 동일한 tool_use 응답을 반환하는 fetchFn — 영원히 tool_use 루프.
    const loopSse = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'tool_use', id: 'tu_n', name: 'Bash', input: {} } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } } },
      { event: 'message_stop', data: {} },
    ])
    const fakeFetch = async () => new Response(
      new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(loopSse)); c.close() } }),
      { status: 200 },
    )
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'loop', options: { model: 'm', maxTurns: 2 } },
      {
        fetchFn: fakeFetch,
        apiKey: 'k',
        canUseTool: async () => ({ behavior: 'allow' }),
        runTool: async () => ({ content: 'ok' }),
      },
    )) {
      yielded.push(m)
    }
    const last = yielded[yielded.length - 1]
    assert.equal(last.type, 'result')
    assert.equal(last.subtype, 'error_max_turns')
  })
})

describe('runAnthropicTurnManager — abort', () => {
  it('signal.aborted 시 다음 turn 시작 전 종료', async () => {
    const ssePayload = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } } },
      { event: 'message_stop', data: {} },
    ])
    const ac = new AbortController()
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'x', options: { model: 'm' } },
      {
        fetchFn: mockFetch(ssePayload),
        apiKey: 'k',
        signal: ac.signal,
        canUseTool: async () => ({ behavior: 'allow' }),
        runTool: async () => { ac.abort(); return { content: 'ok' } },
      },
    )) {
      yielded.push(m)
    }
    // assistant + user(tool_result) 까지는 yield되지만, 다음 turn 시작 전 break
    assert.ok(yielded.find((m) => m.type === 'assistant'))
    assert.ok(yielded.find((m) => m.type === 'user'))
    assert.ok(!yielded.find((m) => m.type === 'result'))
  })
})

// ── shape 동등성: sdkMessageToLLMEvents가 turn-manager 출력에 그대로 동작 ──

describe('shape 동등성 검증 (sdkMessageToLLMEvents 호환)', () => {
  it('assistant message → text_delta + usage', async () => {
    const ssePayload = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 12, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'Hi' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } } },
      { event: 'message_stop', data: {} },
    ])
    const events = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'hi', options: { model: 'm' } },
      { fetchFn: mockFetch(ssePayload), apiKey: 'k' },
    )) {
      for (const e of sdkMessageToLLMEvents(m)) events.push(e)
    }
    // sdkMessageToLLMEvents는 result에 대해 turn_end를 emit하지만 turn-manager의 result는
    // SDK 형식과 일치하므로 동일 결과를 얻어야 함.
    const types = events.map((e) => e.type)
    assert.ok(types.includes('text_delta'))
    assert.ok(types.includes('usage'))
    assert.ok(types.includes('turn_end'))
    const turnEnd = events.find((e) => e.type === 'turn_end')
    assert.equal(turnEnd.stop_reason, 'end_turn')
  })

  it('tool_use message → tool_use_start + delta + end', async () => {
    const ssePayload = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } },
      { event: 'message_stop', data: {} },
    ])
    const turn2 = sse([
      { event: 'message_start', data: { message: { usage: { input_tokens: 30, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'OK' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
      { event: 'message_stop', data: {} },
    ])
    const events = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'x', options: { model: 'm' } },
      {
        fetchFn: mockFetch([ssePayload, turn2]),
        apiKey: 'k',
        canUseTool: async () => ({ behavior: 'allow' }),
        runTool: async () => ({ content: 'done' }),
      },
    )) {
      for (const e of sdkMessageToLLMEvents(m)) events.push(e)
    }
    // tool_use 분해 3종 + 텍스트 + usage + turn_end
    const types = events.map((e) => e.type)
    assert.ok(types.includes('tool_use_start'))
    assert.ok(types.includes('tool_use_delta'))
    assert.ok(types.includes('tool_use_end'))
    assert.ok(types.includes('turn_end'))
    const tuStart = events.find((e) => e.type === 'tool_use_start')
    assert.equal(tuStart.tool.id, 'tu_1')
    assert.equal(tuStart.tool.name, 'Read')
    const tuDelta = events.find((e) => e.type === 'tool_use_delta')
    assert.equal(tuDelta.input_delta, '{"path":"x"}')
  })
})

// ══ 3.2: 정규화 layer 테스트 ════════════════════════════════════════════

describe('getAnthropicMaxOutput — 모델별 max_tokens', () => {
  it('표 등재 모델 14개 모두 정확히 매핑', () => {
    for (const [key, expected] of Object.entries(ANTHROPIC_OUTPUT_LIMITS)) {
      assert.equal(getAnthropicMaxOutput(key), expected, `mismatch: ${key}`)
    }
  })

  it('점 표기(claude-opus-4.7)도 하이픈 표기와 동일 결과', () => {
    assert.equal(getAnthropicMaxOutput('claude-opus-4.7'), 128_000)
    assert.equal(getAnthropicMaxOutput('claude-opus-4.6'), 128_000)
    assert.equal(getAnthropicMaxOutput('claude-sonnet-4.6'), 64_000)
  })

  it('anthropic/ 접두사 + 날짜 suffix도 정상 매칭', () => {
    assert.equal(getAnthropicMaxOutput('anthropic/claude-sonnet-4-6'), 64_000)
    assert.equal(getAnthropicMaxOutput('claude-sonnet-4-6-20250929'), 64_000)
    assert.equal(getAnthropicMaxOutput('claude-opus-4-7:1m'), 128_000)
  })

  it('longest-prefix 매칭 (claude-3-5-sonnet vs claude-3-5)', () => {
    // 'claude-3-5'와 'claude-3-5-sonnet'이 둘 다 매칭되면 더 긴 쪽 win.
    assert.equal(getAnthropicMaxOutput('claude-3-5-sonnet'), 8_192)
  })

  it('등재되지 않은 모델은 기본값', () => {
    assert.equal(getAnthropicMaxOutput('unknown-model'), ANTHROPIC_DEFAULT_OUTPUT_LIMIT)
    assert.equal(getAnthropicMaxOutput(''), ANTHROPIC_DEFAULT_OUTPUT_LIMIT)
  })

  it('thinking 활성 모델은 starve되지 않는 충분한 max_tokens (>16384)', () => {
    // 16384 일괄 하드코딩의 문제 — thinking 토큰이 잠식. 최소 32K 보장 검증.
    for (const m of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5']) {
      assert.ok(getAnthropicMaxOutput(m) > 16384, `${m} starve risk: ${getAnthropicMaxOutput(m)}`)
    }
  })
})

describe('supportsAdaptiveThinking / supportsXhighEffort', () => {
  it('4.6/4.7 세대만 adaptive thinking 지원', () => {
    for (const m of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4.6', 'claude-sonnet-4.7']) {
      assert.equal(supportsAdaptiveThinking(m), true, `${m} should support`)
    }
    for (const m of ['claude-opus-4-5', 'claude-sonnet-4', 'claude-3-7-sonnet', 'claude-3-5-sonnet']) {
      assert.equal(supportsAdaptiveThinking(m), false, `${m} should NOT support`)
    }
  })

  it('xhigh effort는 4.7만 (4.6도 false)', () => {
    assert.equal(supportsXhighEffort('claude-opus-4-7'), true)
    assert.equal(supportsXhighEffort('claude-opus-4.7'), true)
    assert.equal(supportsXhighEffort('claude-sonnet-4-6'), false)
    assert.equal(supportsXhighEffort('claude-opus-4-5'), false)
  })

  it('forbidsSamplingParams는 4.7만', () => {
    assert.equal(forbidsSamplingParams('claude-opus-4-7'), true)
    assert.equal(forbidsSamplingParams('claude-sonnet-4-6'), false)
    assert.equal(forbidsSamplingParams('claude-3-5-sonnet'), false)
  })
})

describe('buildThinkingOptions', () => {
  it('adaptive 모델 + 기본 effort medium', () => {
    const t = buildThinkingOptions('claude-sonnet-4-6', undefined)
    assert.deepEqual(t, {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
    })
  })

  it('thinking=false → null', () => {
    assert.equal(buildThinkingOptions('claude-sonnet-4-6', false), null)
  })

  it('non-adaptive 모델은 thinking 옵션이 있어도 null', () => {
    assert.equal(buildThinkingOptions('claude-3-5-sonnet', { effort: 'high' }), null)
  })

  it('effort 명시 적용', () => {
    const t = buildThinkingOptions('claude-opus-4-7', { effort: 'high' })
    assert.equal(t.output_config.effort, 'high')
  })

  it('xhigh on 4.6 → max로 다운그레이드', () => {
    const t = buildThinkingOptions('claude-sonnet-4-6', { effort: 'xhigh' })
    assert.equal(t.output_config.effort, 'max')
  })

  it('xhigh on 4.7 → xhigh 유지', () => {
    const t = buildThinkingOptions('claude-opus-4-7', { effort: 'xhigh' })
    assert.equal(t.output_config.effort, 'xhigh')
  })

  it('legacy minimal → low로 매핑', () => {
    const t = buildThinkingOptions('claude-opus-4-7', { effort: 'minimal' })
    assert.equal(t.output_config.effort, 'low')
  })
})

describe('applyPromptCacheControl — system_and_3 전략', () => {
  it('system + 메시지 3개 → breakpoints 4개', () => {
    const result = applyPromptCacheControl({
      system: 'You are X',
      messages: [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
        { role: 'user', content: 'C' },
      ],
    })
    assert.equal(result.breakpoints, 4)
    // system은 string → array of text block + cache_control
    assert.ok(Array.isArray(result.system))
    assert.deepEqual(result.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
    // 각 메시지 content가 array로 승격되고 마지막 블록에 cache_control 존재
    for (const m of result.messages) {
      assert.ok(Array.isArray(m.content))
      const last = m.content[m.content.length - 1]
      assert.deepEqual(last.cache_control, { type: 'ephemeral', ttl: '1h' })
    }
  })

  it('메시지 5개 → system + 마지막 3개에만 마커 (총 4개, 1·2번째 메시지에는 없음)', () => {
    const result = applyPromptCacheControl({
      system: 'sys',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
        { role: 'assistant', content: 'fourth' },
        { role: 'user', content: 'fifth' },
      ],
    })
    assert.equal(result.breakpoints, 4)
    // first, second는 string 그대로 (마커 없음)
    assert.equal(typeof result.messages[0].content, 'string')
    assert.equal(typeof result.messages[1].content, 'string')
    // third, fourth, fifth는 array + 마커
    assert.ok(Array.isArray(result.messages[2].content))
    assert.ok(Array.isArray(result.messages[3].content))
    assert.ok(Array.isArray(result.messages[4].content))
  })

  it('system 없으면 메시지 3개까지만 (max 3 breakpoints)', () => {
    const result = applyPromptCacheControl({
      system: undefined,
      messages: [
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
        { role: 'user', content: 'C' },
        { role: 'assistant', content: 'D' },
      ],
    })
    // 마지막 4개 (system 자리 비어서 remaining=4) — 메시지 4개 모두 마커. 실제로는 4개까지 허용.
    // 본 함수는 remaining = 4 - breakpoints(=0) = 4를 사용하므로 4개 전부 마커 = 4 breakpoints.
    assert.equal(result.breakpoints, 4)
  })

  it('ttl=5m이면 ttl 필드 없는 마커', () => {
    const result = applyPromptCacheControl({
      system: 'sys',
      messages: [{ role: 'user', content: 'A' }],
      ttl: '5m',
    })
    assert.deepEqual(result.system[0].cache_control, { type: 'ephemeral' })
  })

  it('list 콘텐츠는 마지막 블록에만 cache_control 부착', () => {
    const result = applyPromptCacheControl({
      system: undefined,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'tu2', content: 'ok' },
          ],
        },
      ],
    })
    const blocks = result.messages[0].content
    assert.equal(blocks[0].cache_control, undefined, '첫 블록은 마커 없음')
    assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral', ttl: '1h' })
  })

  it('호출 후 원본 messages는 변하지 않음 (in-place 수정 없음)', () => {
    const original = [{ role: 'user', content: 'A' }]
    applyPromptCacheControl({ system: 'sys', messages: original })
    assert.equal(original[0].content, 'A')
    assert.equal(typeof original[0].content, 'string')
  })

  it('빈 messages도 안전 — system만 마커', () => {
    const result = applyPromptCacheControl({ system: 'sys', messages: [] })
    assert.equal(result.breakpoints, 1)
    assert.ok(Array.isArray(result.system))
  })
})

describe('buildAnthropicRequest — 3.2 정규화 통합', () => {
  it('maxTokens 미지정 시 모델 테이블에서 자동 산출', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(body.max_tokens, 64_000)
  })

  it('maxTokens 명시 시 그대로 사용', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8192,
    })
    assert.equal(body.max_tokens, 8192)
  })

  it('adaptive 모델은 thinking 자동 활성화 (effort=medium)', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(body.output_config, { effort: 'medium' })
  })

  it('non-adaptive 모델은 thinking 필드 없음', () => {
    const body = buildAnthropicRequest({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(body.thinking, undefined)
    assert.equal(body.output_config, undefined)
  })

  it('thinking=false 명시 시 adaptive 모델이어도 비활성', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: false,
    })
    assert.equal(body.thinking, undefined)
  })

  it('기본적으로 cache_control 마커 자동 삽입 (system + 메시지)', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are X',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.ok(Array.isArray(body.system))
    assert.ok(body.system[0].cache_control)
    assert.ok(Array.isArray(body.messages[0].content))
    assert.ok(body.messages[0].content[0].cache_control)
  })

  it('cacheControl=false 시 마커 없음', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are X',
      messages: [{ role: 'user', content: 'hi' }],
      cacheControl: false,
    })
    assert.equal(body.system, 'You are X')
    assert.equal(typeof body.messages[0].content, 'string')
  })

  it('cacheControl.ttl=5m 시 ttl 필드 없는 마커', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      cacheControl: { ttl: '5m' },
    })
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' })
  })

  it('4.7 모델에서 sampling param 자동 제거', () => {
    const body = buildAnthropicRequest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      topP: 0.9,
      topK: 50,
    })
    assert.equal(body.temperature, undefined)
    assert.equal(body.top_p, undefined)
    assert.equal(body.top_k, undefined)
  })

  it('4.6 모델에서는 sampling param 유지', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
    })
    assert.equal(body.temperature, 0.5)
  })

  it('thinking effort 옵션 전달', () => {
    const body = buildAnthropicRequest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { effort: 'high' },
    })
    assert.equal(body.output_config.effort, 'high')
  })

  it('호출자가 준 messages 원본은 변형하지 않음', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    buildAnthropicRequest({ model: 'claude-sonnet-4-6', messages })
    assert.equal(messages[0].content, 'hi')
  })
})

describe('runAnthropicTurnManager — 3.2 정규화 통합', () => {
  it('네트워크 호출 body가 모델 max_tokens + thinking + cache 마커를 모두 포함', async () => {
    const ssePayload =
      `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text: 'OK' } })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n` +
      `event: message_stop\ndata: {}\n\n`

    let observedBody = null
    const fakeFetch = async (_url, init) => {
      observedBody = JSON.parse(init.body)
      return new Response(
        new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode(ssePayload)); c.close() },
        }),
        { status: 200 },
      )
    }

    for await (const _ of runAnthropicTurnManager(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6', systemPrompt: 'You are daiops' } },
      { fetchFn: fakeFetch, apiKey: 'k' },
    )) { /* consume */ }

    assert.ok(observedBody)
    assert.equal(observedBody.model, 'claude-sonnet-4-6')
    assert.equal(observedBody.max_tokens, 64_000) // 모델 테이블에서 자동
    // thinking 자동 wiring
    assert.deepEqual(observedBody.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(observedBody.output_config, { effort: 'medium' })
    // cache 마커
    assert.ok(Array.isArray(observedBody.system))
    assert.ok(observedBody.system[0].cache_control)
    assert.ok(Array.isArray(observedBody.messages[0].content))
    assert.ok(observedBody.messages[0].content[0].cache_control)
  })

  it('options.thinking=false 전달 시 thinking 비활성', async () => {
    const ssePayload =
      `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })}\n\n` +
      `event: message_stop\ndata: {}\n\n`

    let observedBody = null
    const fakeFetch = async (_url, init) => {
      observedBody = JSON.parse(init.body)
      return new Response(
        new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ssePayload)); c.close() } }),
        { status: 200 },
      )
    }

    for await (const _ of runAnthropicTurnManager(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6', thinking: false } },
      { fetchFn: fakeFetch, apiKey: 'k' },
    )) { /* consume */ }

    assert.equal(observedBody.thinking, undefined)
    assert.equal(observedBody.output_config, undefined)
  })

  it('options.cacheControl=false 전달 시 cache 마커 미삽입', async () => {
    const ssePayload =
      `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })}\n\n` +
      `event: message_stop\ndata: {}\n\n`

    let observedBody = null
    const fakeFetch = async (_url, init) => {
      observedBody = JSON.parse(init.body)
      return new Response(
        new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ssePayload)); c.close() } }),
        { status: 200 },
      )
    }

    for await (const _ of runAnthropicTurnManager(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6', systemPrompt: 'sys', cacheControl: false } },
      { fetchFn: fakeFetch, apiKey: 'k' },
    )) { /* consume */ }

    assert.equal(observedBody.system, 'sys')
    assert.equal(typeof observedBody.messages[0].content, 'string')
  })
})

// ── 헬퍼: 순차 응답 fetch (200 SSE 또는 에러 상태) + 요청 body 캡처 ──────
function seqFetch(responses) {
  const calls = []
  let i = 0
  const fn = async (_url, init) => {
    calls.push(init?.body ? JSON.parse(init.body) : null)
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    if (r.status && r.status >= 400) {
      return new Response(r.body ?? 'err', { status: r.status })
    }
    return new Response(
      new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(r.sse)); c.close() } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  fn.calls = calls
  return fn
}

const SSE_THINKING_TOOLUSE = sse([
  { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
  { event: 'content_block_start', data: { index: 0, content_block: { type: 'thinking', thinking: '' } } },
  { event: 'content_block_delta', data: { index: 0, delta: { type: 'thinking_delta', thinking: 'let me read it' } } },
  { event: 'content_block_delta', data: { index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } } },
  { event: 'content_block_stop', data: { index: 0 } },
  { event: 'content_block_start', data: { index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} } } },
  { event: 'content_block_delta', data: { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } } },
  { event: 'content_block_stop', data: { index: 1 } },
  { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } } },
  { event: 'message_stop', data: {} },
])

const SSE_FINAL_TEXT = sse([
  { event: 'message_start', data: { message: { usage: { input_tokens: 50, output_tokens: 0 } } } },
  { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'Done' } } },
  { event: 'content_block_stop', data: { index: 0 } },
  { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
  { event: 'message_stop', data: {} },
])

// ── accumulateTurn — thinking 블록 보존/드롭 (P1 ①) ─────────────────────
describe('accumulateTurn — thinking 블록 보존', () => {
  async function* iter(events) { for (const e of events) yield e }

  it('서명 있는 thinking 블록 → thinking+signature 보존', async () => {
    const out = []
    for await (const o of accumulateTurn(iter([
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'content_block_start', data: { index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 1, delta: { type: 'text_delta', text: 'hi' } } },
      { event: 'content_block_stop', data: { index: 1 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' } } },
      { event: 'message_stop', data: {} },
    ]))) out.push(o)
    const content = out[0].content
    // thinking 블록이 text보다 앞에 보존
    assert.deepEqual(content[0], { type: 'thinking', thinking: 'reason', signature: 'sig-1' })
    assert.deepEqual(content[1], { type: 'text', text: 'hi' })
  })

  it('서명 없는 thinking 블록 → 드롭 (회귀 없음)', async () => {
    const out = []
    for await (const o of accumulateTurn(iter([
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { event: 'content_block_delta', data: { index: 0, delta: { type: 'thinking_delta', thinking: 'unsigned' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'content_block_start', data: { index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 1, delta: { type: 'text_delta', text: 'hi' } } },
      { event: 'content_block_stop', data: { index: 1 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' } } },
      { event: 'message_stop', data: {} },
    ]))) out.push(o)
    assert.deepEqual(out[0].content, [{ type: 'text', text: 'hi' }])
  })

  it('redacted_thinking → data 보존', async () => {
    const out = []
    for await (const o of accumulateTurn(iter([
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'redacted_thinking', data: 'enc-xyz' } } },
      { event: 'content_block_stop', data: { index: 0 } },
      { event: 'content_block_start', data: { index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { index: 1, delta: { type: 'text_delta', text: 'hi' } } },
      { event: 'content_block_stop', data: { index: 1 } },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' } } },
      { event: 'message_stop', data: {} },
    ]))) out.push(o)
    assert.deepEqual(out[0].content[0], { type: 'redacted_thinking', data: 'enc-xyz' })
  })
})

// ── 멀티턴 thinking 보존 (P1 ①) ─────────────────────────────────────────
describe('runAnthropicTurnManager — thinking 멀티턴 보존', () => {
  it('tool_use turn의 thinking 블록이 다음 turn 요청 messages에 보존된다', async () => {
    const fetchFn = seqFetch([{ sse: SSE_THINKING_TOOLUSE }, { sse: SSE_FINAL_TEXT }])
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'read a.ts', options: { model: 'claude-sonnet-4-6' } },
      { fetchFn, apiKey: 'k', canUseTool: async () => ({ behavior: 'allow' }), runTool: async () => ({ content: 'data' }) },
    )) yielded.push(m)

    // turn 2 요청 body의 assistant 메시지에 thinking 블록이 동봉됐는지
    const turn2Body = fetchFn.calls[1]
    const assistantMsg = turn2Body.messages.find((m) => m.role === 'assistant')
    assert.ok(Array.isArray(assistantMsg.content))
    const thinkingBlock = assistantMsg.content.find((b) => b.type === 'thinking')
    assert.ok(thinkingBlock, 'thinking 블록이 보존돼야 함')
    assert.equal(thinkingBlock.signature, 'sig-abc')
    // 첫 yield된 assistant(turn1)에도 thinking 블록 포함
    assert.equal(yielded[0].message.content[0].type, 'thinking')
    assert.equal(yielded[yielded.length - 1].subtype, 'success')
  })
})

// ── thinking 서명 무효 1회 복구 (P1 ①) ──────────────────────────────────
describe('runAnthropicTurnManager — thinking 서명 복구', () => {
  it('보존한 thinking 블록이 400(signature)이면 strip 후 1회 재시도하여 성공', async () => {
    // turn1: thinking+tool_use, turn2 호출1: 400 signature, turn2 호출2(복구): end_turn
    const fetchFn = seqFetch([
      { sse: SSE_THINKING_TOOLUSE },
      { status: 400, body: 'messages.1: thinking blocks must have a valid signature' },
      { sse: SSE_FINAL_TEXT },
    ])
    const retries = []
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'go', options: { model: 'claude-sonnet-4-6' } },
      {
        fetchFn, apiKey: 'k',
        canUseTool: async () => ({ behavior: 'allow' }),
        runTool: async () => ({ content: 'data' }),
        onRetry: (info) => retries.push(info),
      },
    )) yielded.push(m)

    assert.equal(yielded[yielded.length - 1].subtype, 'success')
    assert.ok(retries.some((r) => r.reason === 'thinking_signature'), 'thinking_signature 복구가 발동해야 함')
    // 복구 재시도(3번째 호출) 요청에는 thinking 블록이 없어야 함
    const recoveredBody = fetchFn.calls[2]
    const asst = recoveredBody.messages.find((m) => m.role === 'assistant')
    assert.ok(!asst.content.some((b) => b.type === 'thinking'), '복구 후 thinking 블록 제거됨')
  })
})

// ── mid-turn 재시도 (P1 ②) ──────────────────────────────────────────────
describe('runAnthropicTurnManager — 멀티턴 중간 turn 재시도', () => {
  it('turn 1(두 번째 turn)의 429 일시 실패는 재시도 후 성공', async () => {
    const fetchFn = seqFetch([
      { sse: SSE_THINKING_TOOLUSE },        // turn 0: tool_use
      { status: 429, body: 'rate limited' }, // turn 1 호출1: 실패
      { sse: SSE_FINAL_TEXT },               // turn 1 호출2: 성공
    ])
    const retries = []
    const yielded = []
    for await (const m of runAnthropicTurnManager(
      { prompt: 'go', options: { model: 'claude-sonnet-4-6' } },
      {
        fetchFn, apiKey: 'k',
        canUseTool: async () => ({ behavior: 'allow' }),
        runTool: async () => ({ content: 'data' }),
        onRetry: (info) => retries.push(info),
        retryOpts: { baseMs: 1, maxMs: 2, maxAttempts: 3 },
      },
    )) yielded.push(m)

    assert.equal(yielded[yielded.length - 1].subtype, 'success')
    assert.ok(retries.some((r) => r.reason === 'rate_limit'), 'turn 1 rate_limit 재시도 발동')
    assert.equal(fetchFn.calls.length, 3)
  })

  it('turn 0의 429는 inner 재시도하지 않고 throw (handler outer 래퍼 소유)', async () => {
    const fetchFn = seqFetch([{ status: 429, body: 'rate limited' }])
    await assert.rejects(
      (async () => {
        for await (const _ of runAnthropicTurnManager(
          { prompt: 'go', options: { model: 'claude-sonnet-4-6' } },
          { fetchFn, apiKey: 'k', retryOpts: { baseMs: 1 } },
        )) { /* consume */ }
      })(),
      /429/,
    )
    assert.equal(fetchFn.calls.length, 1, 'turn 0은 inner 재시도 없음')
  })
})

// ── 헬퍼 단위 (P1 ①) ────────────────────────────────────────────────────
describe('isThinkingSignatureError / stripThinkingBlocks', () => {
  it('isThinkingSignatureError: 400 + thinking + signature → true', () => {
    assert.equal(isThinkingSignatureError({ status: 400, body: 'thinking block signature invalid' }), true)
    assert.equal(isThinkingSignatureError({ status: 400, body: 'bad request: missing model' }), false)
    assert.equal(isThinkingSignatureError({ status: 429, body: 'thinking signature' }), false)
    assert.equal(isThinkingSignatureError('plain string'), false)
  })

  it('stripThinkingBlocks: assistant 메시지의 thinking/redacted_thinking만 제거', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'r', signature: 's' },
        { type: 'redacted_thinking', data: 'd' },
        { type: 'text', text: 'a' },
        { type: 'tool_use', id: 't', name: 'Read', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
    ]
    stripThinkingBlocks(messages)
    assert.deepEqual(messages[1].content, [
      { type: 'text', text: 'a' },
      { type: 'tool_use', id: 't', name: 'Read', input: {} },
    ])
    // user 메시지는 불변
    assert.equal(messages[0].content, 'hi')
    assert.equal(messages[2].content[0].type, 'tool_result')
  })
})

describe('streamWithStaleGuard', () => {
  /**
   * N개 chunk를 yield한 뒤 next()가 멈추는(=stall) async iterable.
   * `await new Promise(()=>{})`처럼 영영 안 풀리면 node:test가 "pending promise"로 잡으므로,
   * guard의 finally가 호출하는 return()에서 멈춘 promise를 settle해 깔끔히 해제한다.
   * (프로덕션의 실제 fetch 스트림은 onStale의 abort로 read가 reject돼 동일하게 정리된다.)
   */
  function hangingIterable(chunks) {
    let resolveHang
    const hang = new Promise((res) => { resolveHang = res })
    let i = 0
    const iterator = {
      async next() {
        if (i < chunks.length) return { value: chunks[i++], done: false }
        await hang
        return { value: undefined, done: true }
      },
      async return() { resolveHang?.(); return { value: undefined, done: true } },
    }
    return { [Symbol.asyncIterator]: () => iterator }
  }

  /**
   * stale 검출은 guard 내부의 *unref된* idle 타이머에 의존하는데, 테스트에서 다른 ref된 작업이
   * 없으면 node:test 러너(특히 node 22)가 그 타이머 발화 전에 이벤트 루프를 "종료됨"으로 보고
   * 서브테스트를 cancel한다("event loop has already resolved"). ref된 keepalive로 stale 검출
   * 구간 동안 루프를 살려두고, 검출 후 해제한다. (프로덕션 unref는 그대로 — 프로세스 비점유 목적)
   */
  async function withEventLoopAlive(fn) {
    const keepAlive = setInterval(() => {}, 1_000)
    try {
      return await fn()
    } finally {
      clearInterval(keepAlive)
    }
  }

  /** idleMs 안에 모든 chunk가 흐르면 그대로 통과시킨다. */
  it('정상 스트림은 chunk를 그대로 yield', async () => {
    async function* src() {
      yield 'a'
      yield 'b'
      yield 'c'
    }
    const out = []
    for await (const c of streamWithStaleGuard(src(), 1000, () => {})) out.push(c)
    assert.deepEqual(out, ['a', 'b', 'c'])
  })

  /** chunk 사이 간격이 idleMs를 넘으면 stale로 ETIMEDOUT throw + onStale 1회 호출. */
  it('idle 초과 시 ETIMEDOUT throw 및 onStale 호출', async () => {
    let staleCalls = 0
    const received = []
    await withEventLoopAlive(() => assert.rejects(
      async () => {
        for await (const c of streamWithStaleGuard(hangingIterable(['first']), 30, () => { staleCalls++ })) {
          received.push(c)
        }
      },
      (err) => err && err.code === 'ETIMEDOUT' && err.stale === true,
    ))
    assert.deepEqual(received, ['first'])
    assert.equal(staleCalls, 1)
  })

  /** 첫 chunk조차 오지 않는 TTFB stall도 감지(가장 흔한 케이스). */
  it('첫 chunk 전 stall(TTFB)도 감지', async () => {
    let staleCalls = 0
    await withEventLoopAlive(() => assert.rejects(
      async () => {
        for await (const _ of streamWithStaleGuard(hangingIterable([]), 20, () => { staleCalls++ })) { /* drain */ }
      },
      (err) => err.code === 'ETIMEDOUT',
    ))
    assert.equal(staleCalls, 1)
  })
})
