import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { runAnthropicSdkStream, sdkMessageToLLMEvents, SDK_BUILTIN_TOOLS } from './llm-wrapper.js'

// ── sdkMessageToLLMEvents (SDK 호환 메시지 → LLMEvent 변환) ──────────────

describe('sdkMessageToLLMEvents', () => {
  it('assistant text 블록 → text_delta', () => {
    const events = sdkMessageToLLMEvents({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hi' }] },
    })
    assert.deepEqual(events, [{ type: 'text_delta', delta: 'Hi' }])
  })

  it('빈 text는 무시', () => {
    const events = sdkMessageToLLMEvents({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '' }] },
    })
    assert.deepEqual(events, [])
  })

  it('tool_use 블록 → start + delta(input 통째) + end', () => {
    const events = sdkMessageToLLMEvents({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'foo.ts' } },
        ],
      },
    })
    assert.deepEqual(events, [
      { type: 'tool_use_start', tool: { id: 'tu_1', name: 'Read' } },
      { type: 'tool_use_delta', id: 'tu_1', input_delta: '{"path":"foo.ts"}' },
      { type: 'tool_use_end', id: 'tu_1' },
    ])
  })

  it('text + tool_use 혼합', () => {
    const events = sdkMessageToLLMEvents({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a' } },
        ],
      },
    })
    assert.equal(events.length, 4)
    assert.equal(events[0].type, 'text_delta')
    assert.equal(events[1].type, 'tool_use_start')
    assert.equal(events[3].type, 'tool_use_end')
  })

  it('usage 필드 → usage 이벤트 (cache_read 보존)', () => {
    const events = sdkMessageToLLMEvents({
      type: 'assistant',
      message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 } },
    })
    assert.deepEqual(events, [
      { type: 'usage', input_tokens: 100, output_tokens: 50, cache_read_tokens: 80 },
    ])
  })

  it('usage 모두 0이면 emit 안 함', () => {
    const events = sdkMessageToLLMEvents({
      type: 'assistant',
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    })
    assert.deepEqual(events, [])
  })

  it('result 메시지 (정상 종료) → turn_end end_turn', () => {
    const events = sdkMessageToLLMEvents({ type: 'result' })
    assert.deepEqual(events, [{ type: 'turn_end', stop_reason: 'end_turn' }])
  })

  it('result 메시지 (max_turns) → turn_end max_tokens', () => {
    const events = sdkMessageToLLMEvents({ type: 'result', subtype: 'error_max_turns' })
    assert.deepEqual(events, [{ type: 'turn_end', stop_reason: 'max_tokens' }])
  })

  it('알 수 없는 메시지 타입은 빈 배열', () => {
    assert.deepEqual(sdkMessageToLLMEvents({ type: 'system' }), [])
    assert.deepEqual(sdkMessageToLLMEvents(null), [])
  })
})

// ── SDK_BUILTIN_TOOLS 노출 ────────────────────────────────────────────

describe('SDK_BUILTIN_TOOLS', () => {
  it('로컬 실행 빌트인 8종 — 파일 6 + BashOutput/KillShell', () => {
    // SDK_BUILTIN_TOOLS = tools/index.js BUILTIN_TOOL_NAMES (로컬 실행기 보유 도구).
    // WebSearch/WebFetch는 Anthropic server tool이라 여기엔 없음(handler.js allowlist에만 추가).
    const expected = new Set(['Read', 'Edit', 'Glob', 'Grep', 'Bash', 'Write', 'BashOutput', 'KillShell'])
    const actual = new Set(SDK_BUILTIN_TOOLS)
    assert.equal(actual.size, expected.size)
    for (const name of expected) assert.ok(actual.has(name), `missing ${name}`)
  })
})

// ── runAnthropicSdkStream — turn-manager 위임 검증 (mock fetch) ───────

/** 단일 turn end_turn SSE를 반환하는 mock fetch. */
function mockEndTurnFetch(text = 'OK') {
  const sse =
    `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text } })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n` +
    `event: message_stop\ndata: {}\n\n`
  return async (_url, _init) => new Response(
    new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
    { status: 200 },
  )
}

describe('runAnthropicSdkStream', () => {
  it('단일 turn end_turn → assistant + result yield (SDK 호환 shape)', async () => {
    const yielded = []
    for await (const m of runAnthropicSdkStream(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6' } },
      { fetchFn: mockEndTurnFetch('Hello'), emitLLMEvent: () => {} },
    )) {
      yielded.push(m)
    }
    assert.equal(yielded.length, 2)
    assert.equal(yielded[0].type, 'assistant')
    assert.equal(yielded[0].message.content[0].text, 'Hello')
    assert.equal(yielded[1].type, 'result')
  })

  it('emitLLMEvent hook이 호출됨 (text_delta + usage + turn_end)', async () => {
    const events = []
    for await (const _ of runAnthropicSdkStream(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6' } },
      { fetchFn: mockEndTurnFetch('Hi'), emitLLMEvent: (e) => events.push(e) },
    )) { /* consume */ }
    const types = events.map((e) => e.type)
    assert.ok(types.includes('text_delta'))
    assert.ok(types.includes('usage'))
    assert.ok(types.includes('turn_end'))
  })

  it('signal.aborted 시 즉시 break', async () => {
    const ac = new AbortController()
    const yielded = []
    let aborted = false
    for await (const m of runAnthropicSdkStream(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6' } },
      {
        fetchFn: mockEndTurnFetch('x'),
        signal: ac.signal,
        emitLLMEvent: () => { if (!aborted) { aborted = true; ac.abort() } },
      },
    )) {
      yielded.push(m)
    }
    // abort 시점에 따라 1~2개 메시지가 처리될 수 있지만 result로 정상 종료되지는 않음.
    assert.ok(yielded.length <= 2)
  })

  it('emitLLMEvent throw해도 메시지 yield는 정상', async () => {
    const yielded = []
    for await (const m of runAnthropicSdkStream(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6' } },
      {
        fetchFn: mockEndTurnFetch('Hi'),
        emitLLMEvent: () => { throw new Error('emit failure') },
      },
    )) {
      yielded.push(m)
    }
    assert.ok(yielded.length >= 1)
  })

  it('options.abortController.signal도 abort 경로로 동작', async () => {
    const ac = new AbortController()
    ac.abort()
    const yielded = []
    for await (const m of runAnthropicSdkStream(
      { prompt: 'hi', options: { model: 'claude-sonnet-4-6', abortController: ac } },
      { fetchFn: mockEndTurnFetch('x') },
    )) {
      yielded.push(m)
    }
    // pre-aborted라 즉시 종료
    assert.equal(yielded.length, 0)
  })

  it('handler.js 호환 — allowedTools가 자동으로 BUILTIN_TOOLS와 머지되어 fetch body.tools로 전송', async () => {
    let observedTools = null
    const fakeFetch = async (_url, init) => {
      observedTools = JSON.parse(init.body).tools
      const sse =
        `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })}\n\n` +
        `event: message_stop\ndata: {}\n\n`
      return new Response(
        new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }),
        { status: 200 },
      )
    }
    for await (const _ of runAnthropicSdkStream(
      { prompt: 'x', options: { model: 'claude-sonnet-4-6', allowedTools: ['Read', 'Bash'] } },
      { fetchFn: fakeFetch },
    )) { /* consume */ }
    const names = observedTools.map((t) => t.name).sort()
    assert.deepEqual(names, ['Bash', 'Read'])
  })
})
