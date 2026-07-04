import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildAnthropicRequest } from './turn-manager.js'
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
