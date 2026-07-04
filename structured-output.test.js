import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildAnthropicRequest, runAnthropicTurnManager } from './turn-manager.js'
import { runAnthropicSdkStream } from './llm-wrapper.js'
import { validateAgainstSchema } from './tools/validate-schema.js'
import { buildStructuredTool, STRUCTURED_TOOL_NAME } from './tools/submit-structured.js'

// ── SSE 헬퍼 (turn-manager.test.js와 동일 계열) ──────────────────────────
function sse(events) {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
}

function mockFetch(sseTexts) {
  const queue = Array.isArray(sseTexts) ? [...sseTexts] : [sseTexts]
  let calls = 0
  const fn = async function fakeFetch() {
    calls++
    const text = queue.shift() ?? ''
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        for (let i = 0; i < text.length; i += 37) controller.enqueue(enc.encode(text.slice(i, i + 37)))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  fn.callCount = () => calls
  return fn
}

/** submit_structured_response tool_use 1턴 SSE. */
function structuredToolTurn(input, id = 'tu1') {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: STRUCTURED_TOOL_NAME, input: {} } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])
}

/** 일반 도구 호출 1턴 SSE (stop_reason=tool_use). */
function regularToolTurn(name, input, id = 'r1') {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])
}

/** 자연 종료 텍스트 1턴 SSE (stop_reason=end_turn). */
function textEndTurn(text) {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])
}

/** 요청 body를 turn별로 캡처하는 mockFetch. */
function mockFetchCapturing(sseTexts) {
  const queue = [...sseTexts]
  const bodies = []
  const fn = async function fakeFetch(_url, init) {
    try { bodies.push(JSON.parse(init.body)) } catch { bodies.push(null) }
    const text = queue.shift() ?? ''
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        for (let i = 0; i < text.length; i += 37) controller.enqueue(enc.encode(text.slice(i, i + 37)))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  fn.bodies = bodies
  return fn
}

/** turn-manager를 직접 돌려 assistant/result 메시지를 모은다. */
async function collectTurnManager(input, ctx) {
  const messages = []
  for await (const m of runAnthropicTurnManager(input, ctx)) messages.push(m)
  return messages
}

/** 스트림에서 마지막 assistant text(구조화 결과)를 뽑는다. */
async function collectFinalText(stream) {
  let finalText = ''
  for await (const msg of stream) {
    if (msg?.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block && typeof block.text === 'string') finalText += block.text
      }
    }
  }
  return finalText
}

// ── validate-schema ────────────────────────────────────────────────────

describe('validateAgainstSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
      score: { type: 'number' },
    },
    required: ['sentiment', 'score'],
    additionalProperties: false,
  }

  it('스키마 부합 → ok', () => {
    const r = validateAgainstSchema(schema, { sentiment: 'positive', score: 0.9 })
    assert.equal(r.ok, true)
    assert.equal(r.errors.length, 0)
  })

  it('required 누락 → 실패', () => {
    const r = validateAgainstSchema(schema, { sentiment: 'positive' })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('score')))
  })

  it('enum 위반 → 실패', () => {
    const r = validateAgainstSchema(schema, { sentiment: 'happy', score: 1 })
    assert.equal(r.ok, false)
  })

  it('타입 불일치 → 실패', () => {
    const r = validateAgainstSchema(schema, { sentiment: 'positive', score: 'high' })
    assert.equal(r.ok, false)
  })

  it('additionalProperties:false 위반 → 실패', () => {
    const r = validateAgainstSchema(schema, { sentiment: 'positive', score: 1, extra: 1 })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('additional')))
  })

  it('중첩 array items 재귀 검증', () => {
    const s = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'] }
    assert.equal(validateAgainstSchema(s, { tags: ['a', 'b'] }).ok, true)
    assert.equal(validateAgainstSchema(s, { tags: ['a', 1] }).ok, false)
  })
})

// ── buildAnthropicRequest tool_choice ──────────────────────────────────

describe('buildAnthropicRequest — tool_choice', () => {
  it('toolChoice 지정 시 body.tool_choice 설정', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [buildStructuredTool({ type: 'object' })],
      toolChoice: { type: 'tool', name: STRUCTURED_TOOL_NAME },
    })
    assert.deepEqual(body.tool_choice, { type: 'tool', name: STRUCTURED_TOOL_NAME })
  })

  it('toolChoice 미지정 시 tool_choice 없음(회귀)', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal('tool_choice' in body, false)
  })

  it('강제 toolChoice 시 thinking 비활성화 (B1: thinking+forced tool_choice 400 회피)', () => {
    // thinking 지원 모델(4.6)이라도 강제 tool_choice면 thinking을 넣지 않아야 한다.
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [buildStructuredTool({ type: 'object' })],
      toolChoice: { type: 'tool', name: STRUCTURED_TOOL_NAME },
    })
    assert.equal('thinking' in body, false)
    assert.deepEqual(body.tool_choice, { type: 'tool', name: STRUCTURED_TOOL_NAME })
  })

  it('강제 없으면 thinking 정상 활성(회귀)', () => {
    const body = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal('thinking' in body, true)
  })
})

// ── 구조화 출력 종단 흐름 (llm-wrapper + turn-manager) ────────────────────

describe('runAnthropicSdkStream — 구조화 출력', () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  }

  it('검증 통과 → JSON 최종 응답으로 조기 종료(단일 턴)', async () => {
    const fetchFn = mockFetch([structuredToolTurn({ answer: '42' })])
    const stream = runAnthropicSdkStream(
      { prompt: 'q', options: { model: 'claude-sonnet-4-6', responseSchema: schema, allowedTools: [] } },
      { fetchFn },
    )
    const text = await collectFinalText(stream)
    assert.deepEqual(JSON.parse(text), { answer: '42' })
    assert.equal(fetchFn.callCount(), 1)
  })

  it('검증 실패 → is_error 재시도 → 다음 턴 통과', async () => {
    const fetchFn = mockFetch([
      structuredToolTurn({ wrong: 'x' }), // required answer 누락
      structuredToolTurn({ answer: 'ok' }, 'tu2'),
    ])
    const stream = runAnthropicSdkStream(
      { prompt: 'q', options: { model: 'claude-sonnet-4-6', responseSchema: schema, allowedTools: [] } },
      { fetchFn },
    )
    const text = await collectFinalText(stream)
    assert.deepEqual(JSON.parse(text), { answer: 'ok' })
    assert.equal(fetchFn.callCount(), 2)
  })

  it('반복 실패 → 재시도 캡(3)에서 종료(무한 루프 방지)', async () => {
    // 항상 잘못된 입력만 반환하도록 넉넉히 공급.
    const fetchFn = mockFetch(Array.from({ length: 10 }, (_, i) => structuredToolTurn({ wrong: 'x' }, `tu${i}`)))
    const stream = runAnthropicSdkStream(
      { prompt: 'q', options: { model: 'claude-sonnet-4-6', responseSchema: schema, allowedTools: [] } },
      { fetchFn },
    )
    await collectFinalText(stream)
    assert.equal(fetchFn.callCount(), 3) // STRUCTURED_MAX_RETRIES
  })
})

// ── 최종턴만 강제 (AGENT-API-5, turn-manager 직접) ───────────────────────
describe('runAnthropicTurnManager — 최종턴만 강제(final_turn)', () => {
  const structuredToolName = STRUCTURED_TOOL_NAME
  // 이 도구가 검증을 대신한다(llm-wrapper 없이 turn-manager 단독 검증). 통과 시 JSON 문자열 반환.
  const runTool = async (name, input) => {
    if (name === structuredToolName) return { content: JSON.stringify(input) }
    return { content: `${name} 실행됨` }
  }
  const baseInput = (mode) => ({
    prompt: '리서치 후 구조화',
    options: {
      model: 'claude-sonnet-4-6',
      tools: [{ name: 'search', input_schema: { type: 'object' } }, buildStructuredTool({ type: 'object' })],
      structuredToolName,
      ...(mode ? { structuredMode: mode } : {}),
    },
  })

  it('도구 선사용 → end_turn → forcing 1회 전환 후 구조화', async () => {
    const fetchFn = mockFetchCapturing([
      regularToolTurn('search', { q: 'x' }, 'r1'), // turn0: 도구 자유 사용(open)
      textEndTurn('검색을 마쳤습니다. 결론은…'),     // turn1: 자연 종료 → forcing 전환
      structuredToolTurn({ answer: '결론' }, 'tu2'), // turn2: 강제 구조화
    ])
    const msgs = await collectTurnManager(baseInput(), { fetchFn, runTool })

    // per-turn tool_choice: open(0,1)은 미강제, forcing(2)만 강제.
    assert.equal('tool_choice' in fetchFn.bodies[0], false)
    assert.equal('tool_choice' in fetchFn.bodies[1], false)
    assert.deepEqual(fetchFn.bodies[2].tool_choice, { type: 'tool', name: structuredToolName })
    // thinking: open(0,1) 활성, forcing(2) 비활성(400 회피).
    assert.equal('thinking' in fetchFn.bodies[0], true)
    assert.equal('thinking' in fetchFn.bodies[1], true)
    assert.equal('thinking' in fetchFn.bodies[2], false)
    // typed structuredResult가 최종 assistant 메시지에 실린다.
    const structured = msgs.find((m) => m.type === 'assistant' && m.structuredResult !== undefined)
    assert.deepEqual(structured.structuredResult, { answer: '결론' })
    // 마지막은 성공 result.
    assert.equal(msgs.at(-1).type, 'result')
    assert.equal(msgs.at(-1).subtype, 'success')
  })

  it('open phase에서 모델이 스스로 구조화 도구 호출 시 조기 종료', async () => {
    const fetchFn = mockFetchCapturing([structuredToolTurn({ answer: 'now' }, 'tu1')])
    const msgs = await collectTurnManager(baseInput(), { fetchFn, runTool })
    assert.equal(fetchFn.bodies.length, 1) // 전환 없이 turn0에서 종료
    assert.equal('tool_choice' in fetchFn.bodies[0], false) // open이라 미강제
    const structured = msgs.find((m) => m.structuredResult !== undefined)
    assert.deepEqual(structured.structuredResult, { answer: 'now' })
  })

  it('immediate 모드는 turn 0부터 강제', async () => {
    const fetchFn = mockFetchCapturing([structuredToolTurn({ answer: 'x' }, 'tu1')])
    await collectTurnManager(baseInput('immediate'), { fetchFn, runTool })
    assert.deepEqual(fetchFn.bodies[0].tool_choice, { type: 'tool', name: structuredToolName })
    assert.equal('thinking' in fetchFn.bodies[0], false) // 강제라 thinking off
  })
})
