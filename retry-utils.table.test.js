/**
 * classifyLlmError 와 sanitizeErrorDetail 의 갈래를 표로 굳힌다(트랙 G5, 2026-11-25).
 * 2단계 돌연변이에서 classifyLlmError 39, sanitizeErrorDetail 16, SECRET_PATTERNS 10 이 살아남았다.
 * 갈래 순서(앞 갈래가 이겨야 하는 경우)와 경계(정확히 그 상태 코드, 그 낱말)를 함께 본다.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { classifyLlmError, sanitizeErrorDetail } from './retry-utils.js'

const err = (fields) => Object.assign(new Error(fields.message ?? ''), fields)

describe('classifyLlmError: 상태 코드', () => {
  const rows = [
    [429, '', 'rate_limit', true],
    [402, 'credit balance too low', 'billing', false],
    [402, 'usage limit reached, try again later', 'rate_limit', true],
    [402, 'quota exceeded', 'billing', false], // 한도 낱말만, 일시 신호 없음
    [402, 'please wait', 'billing', false], // 일시 신호만, 한도 낱말 없음
    [402, 'Key limit exceeded. Resets at 00:00', 'rate_limit', true],
    [401, '', 'auth', false],
    [403, '', 'auth', false],
    [413, '', 'payload_too_large', false],
    [400, 'prompt is too long: 210000 tokens', 'context_overflow', false],
    [400, 'exceeds the context window', 'context_overflow', false],
    [400, 'maximum of 8192 tokens', 'context_overflow', false],
    [400, 'invalid tool schema', 'bad_request', false],
    [503, '', 'overloaded', true],
    [529, '', 'overloaded', true],
    [500, '', 'server_error', true],
    [502, '', 'server_error', true],
    [504, '', 'server_error', true],
    [404, '', 'unknown', false],
  ]
  for (const [status, message, reason, retryable] of rows) {
    it(`${status} ${message || '(빈 문구)'} → ${reason}`, () => {
      const r = classifyLlmError(err({ status, message }))
      assert.equal(r.reason, reason)
      assert.equal(r.retryable, retryable)
      // 갈래에 걸리지 않은 상태 코드(404 등)는 unknown 으로 떨어지며 status 를 싣지 않는다
      assert.equal(r.status, reason === 'unknown' ? undefined : status)
    })
  }

  it('statusCode 도 status 로 읽는다', () => {
    assert.deepEqual(classifyLlmError(err({ statusCode: 429 })), { reason: 'rate_limit', retryable: true, status: 429 })
  })

  it('status 가 숫자가 아니면 무시한다', () => {
    assert.equal(classifyLlmError(err({ status: '429' })).reason, 'unknown')
  })

  it('ngrok 터널이 죽은 404 는 상태 코드보다 먼저 proxy_unreachable', () => {
    const r = classifyLlmError(err({ status: 404, message: 'The endpoint abc.ngrok-free.app is offline (ERR_NGROK_3200)' }))
    assert.deepEqual(r, { reason: 'proxy_unreachable', retryable: false, status: 404 })
  })

  it('터널 문구는 429 보다도 먼저', () => {
    assert.equal(classifyLlmError(err({ status: 429, message: 'tunnel foo not found' })).reason, 'proxy_unreachable')
  })
})

describe('classifyLlmError: 상태 코드가 없을 때', () => {
  const codes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND']
  for (const code of codes) {
    it(`네트워크 코드 ${code} → timeout(재시도)`, () => {
      assert.deepEqual(classifyLlmError(err({ code })), { reason: 'timeout', retryable: true })
    })
  }

  it('모르는 네트워크 코드는 unknown', () => {
    assert.equal(classifyLlmError(err({ code: 'EPIPE' })).reason, 'unknown')
  })

  it('AbortError → aborted(재시도 안 함)', () => {
    const e = new Error('The operation was aborted')
    e.name = 'AbortError'
    assert.deepEqual(classifyLlmError(e), { reason: 'aborted', retryable: false })
  })

  const messages = [
    ['Rate limit reached', 'rate_limit', true],
    ['rate-limit', 'rate_limit', true],
    ['too many requests', 'rate_limit', true],
    ['tokens per minute exceeded', 'rate_limit', true],
    ['Overloaded', 'overloaded', true],
    ['service temporarily unavailable', 'overloaded', true],
    ['request timed out', 'timeout', true],
    ['deadline exceeded', 'timeout', true],
    ['insufficient credits', 'billing', false],
    ['quota exhausted', 'billing', false],
    ['something odd', 'unknown', false],
  ]
  for (const [message, reason, retryable] of messages) {
    it(`문구 「${message}」 → ${reason}`, () => {
      const r = classifyLlmError(err({ message }))
      assert.equal(r.reason, reason)
      assert.equal(r.retryable, retryable)
      assert.equal(r.status, undefined)
    })
  }

  it('Error 가 아닌 문자열도 문구로 판정한다', () => {
    assert.equal(classifyLlmError('Rate limit hit').reason, 'rate_limit')
  })

  it('null 은 unknown', () => {
    assert.deepEqual(classifyLlmError(null), { reason: 'unknown', retryable: false })
  })
})

describe('sanitizeErrorDetail', () => {
  const secrets = [
    ['Anthropic 키', 'sk-ant-api03-abcdefgh12345678'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123'],
    ['GitHub 토큰', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['AWS 키', 'AKIAABCDEFGHIJKLMNOP'],
  ]
  for (const [label, secret] of secrets) {
    it(`${label}를 가린다`, () => {
      const out = sanitizeErrorDetail(new Error(`failed with ${secret} attached`))
      assert.ok(!out.includes(secret), out)
      assert.match(out, /\[REDACTED\]/)
    })
  }

  it('한 문장에 비밀이 둘이면 둘 다 가린다', () => {
    const out = sanitizeErrorDetail(new Error('a sk-aaaaaaaaaaaa b sk-bbbbbbbbbbbb'))
    assert.equal(out, 'a [REDACTED] b [REDACTED]')
  })

  it('짧은 sk- 는 키가 아니다(8자 미만)', () => {
    assert.equal(sanitizeErrorDetail(new Error('sk-short')), 'sk-short')
  })

  it('body 를 덧붙이되 이미 문구에 있으면 다시 붙이지 않는다', () => {
    assert.equal(sanitizeErrorDetail(err({ message: 'bad', body: '{"x":1}' })), 'bad {"x":1}')
    assert.equal(sanitizeErrorDetail(err({ message: 'bad {"x":1}', body: '{"x":1}' })), 'bad {"x":1}')
  })

  it('body 의 비밀도 가린다', () => {
    const out = sanitizeErrorDetail(err({ message: 'bad', body: 'key=sk-zzzzzzzzzzzz' }))
    assert.equal(out, 'bad key=[REDACTED]')
  })

  it('문자열이 아닌 body 는 무시한다', () => {
    assert.equal(sanitizeErrorDetail(err({ message: 'bad', body: { a: 1 } })), 'bad')
  })

  it('공백과 줄바꿈을 한 칸으로 줄인다', () => {
    assert.equal(sanitizeErrorDetail(new Error('  a\n\n b\t c  ')), 'a b c')
  })

  it('가린 뒤에 자른다(잘린 키 조각이 남지 않게)', () => {
    const out = sanitizeErrorDetail(new Error(`${'x'.repeat(190)} sk-abcdefghijklmnop`), 200)
    assert.ok(!out.includes('sk-abc'), out)
    assert.equal(out.length, 200)
  })

  it('기본 길이는 200', () => {
    assert.equal(sanitizeErrorDetail(new Error('y'.repeat(500))).length, 200)
  })

  it('Error 가 아닌 값도 문자열로', () => {
    assert.equal(sanitizeErrorDetail('plain'), 'plain')
  })
})
