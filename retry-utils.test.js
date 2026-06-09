import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  jitteredBackoff,
  classifyLlmError,
  sanitizeErrorDetail,
  withJitteredRetry,
  asyncIteratorWithFirstYieldRetry,
  DEFAULT_BACKOFF,
} from './retry-utils.js'

describe('jitteredBackoff', () => {
  it('attempt 1은 base 이상, base*(1+jitter) 이하', () => {
    const base = 1000
    const jitter = 0.5
    for (let i = 0; i < 20; i++) {
      const d = jitteredBackoff(1, { baseMs: base, maxMs: 60_000, jitterRatio: jitter })
      assert.ok(d >= base, `delay >= base (got ${d})`)
      assert.ok(d <= base * (1 + jitter) + 1, `delay <= base*(1+jitter) (got ${d})`)
    }
  })

  it('attempt이 늘어나면 평균 delay가 지수적으로 증가', () => {
    const samples = (attempt) => {
      let sum = 0
      for (let i = 0; i < 50; i++) sum += jitteredBackoff(attempt, { baseMs: 1000, maxMs: 60_000 })
      return sum / 50
    }
    const a1 = samples(1)
    const a3 = samples(3)
    assert.ok(a3 > a1 * 2, `attempt 3 mean (${a3}) > attempt 1 mean (${a1}) * 2`)
  })

  it('maxMs를 초과하지 않음', () => {
    const max = 5000
    for (let i = 0; i < 10; i++) {
      const d = jitteredBackoff(20, { baseMs: 1000, maxMs: max, jitterRatio: 0.5 })
      assert.ok(d <= max * 1.5 + 1, `delay <= max*(1+jitter)`)
    }
  })
})

describe('classifyLlmError', () => {
  it('429 → rate_limit retryable', () => {
    const c = classifyLlmError({ status: 429, message: 'Too many requests' })
    assert.equal(c.reason, 'rate_limit')
    assert.equal(c.retryable, true)
  })
  it('503 → overloaded retryable', () => {
    const c = classifyLlmError({ status: 503 })
    assert.equal(c.reason, 'overloaded')
    assert.equal(c.retryable, true)
  })
  it('500 → server_error retryable', () => {
    const c = classifyLlmError({ status: 500 })
    assert.equal(c.reason, 'server_error')
    assert.equal(c.retryable, true)
  })
  it('401 → auth fatal', () => {
    const c = classifyLlmError({ status: 401 })
    assert.equal(c.reason, 'auth')
    assert.equal(c.retryable, false)
  })
  it('402 + usage limit + transient 신호 → rate_limit retryable (월 한도 일시초과)', () => {
    const c = classifyLlmError({ status: 402, message: 'Usage limit exceeded. Please try again at reset.' })
    assert.equal(c.reason, 'rate_limit')
    assert.equal(c.retryable, true)
  })
  it('402 + 크레딧 소진(transient 신호 없음) → billing fatal', () => {
    const c = classifyLlmError({ status: 402, message: 'Your credit balance is too low to access the API.' })
    assert.equal(c.reason, 'billing')
    assert.equal(c.retryable, false)
  })
  it('402 + usage limit이지만 transient 신호 없음 → billing fatal (보수적)', () => {
    const c = classifyLlmError({ status: 402, message: 'Monthly usage limit exceeded.' })
    assert.equal(c.reason, 'billing')
    assert.equal(c.retryable, false)
  })
  it('400 → bad_request fatal', () => {
    const c = classifyLlmError({ status: 400 })
    assert.equal(c.reason, 'bad_request')
    assert.equal(c.retryable, false)
  })
  it('ngrok 404 offline → proxy_unreachable fatal (이번 사고 케이스)', () => {
    const c = classifyLlmError(
      Object.assign(new Error('Anthropic API 404: The endpoint 9d55.ngrok-free.app is offline.\n\nERR_NGROK_3200'), {
        status: 404,
      }),
    )
    assert.equal(c.reason, 'proxy_unreachable')
    assert.equal(c.retryable, false)
  })
  it('400 + prompt too long → context_overflow (bad_request보다 우선)', () => {
    const c = classifyLlmError({ status: 400, message: 'prompt is too long: 250000 tokens > 200000 maximum' })
    assert.equal(c.reason, 'context_overflow')
    assert.equal(c.retryable, false)
  })
  it('ETIMEDOUT → timeout retryable', () => {
    const c = classifyLlmError({ code: 'ETIMEDOUT' })
    assert.equal(c.reason, 'timeout')
    assert.equal(c.retryable, true)
  })
  it('AbortError name → aborted fatal', () => {
    const c = classifyLlmError({ name: 'AbortError', message: 'aborted' })
    assert.equal(c.reason, 'aborted')
    assert.equal(c.retryable, false)
  })
  it('"rate limit" message → rate_limit (status 없을 때)', () => {
    const c = classifyLlmError(new Error('rate limit exceeded for tokens per minute'))
    assert.equal(c.reason, 'rate_limit')
    assert.equal(c.retryable, true)
  })
  it('알 수 없는 에러 → unknown, 보수적으로 retry 안 함', () => {
    const c = classifyLlmError(new Error('weird unexpected'))
    assert.equal(c.reason, 'unknown')
    assert.equal(c.retryable, false)
  })
})

describe('sanitizeErrorDetail', () => {
  it('시크릿(sk-/JWT/ghp_)을 [REDACTED]로 마스킹', () => {
    const d = sanitizeErrorDetail(new Error('failed with key sk-ant-abc123XYZ_456 and token ghp_abcdefghij0123456789'))
    assert.ok(!d.includes('sk-ant-abc123'))
    assert.ok(!d.includes('ghp_abcdefghij'))
    assert.ok(d.includes('[REDACTED]'))
  })
  it('message + body 합쳐 200자 절단', () => {
    const long = 'x'.repeat(500)
    const d = sanitizeErrorDetail(Object.assign(new Error('boom'), { body: long }))
    assert.ok(d.length <= 200)
    assert.ok(d.startsWith('boom'))
  })
})

describe('withJitteredRetry', () => {
  it('성공 케이스: fn이 첫 호출에서 성공하면 그대로 반환', async () => {
    let calls = 0
    const out = await withJitteredRetry(async () => {
      calls++
      return 42
    })
    assert.equal(out, 42)
    assert.equal(calls, 1)
  })

  it('retryable 에러는 maxAttempts까지 재시도', async () => {
    let calls = 0
    let retries = 0
    await assert.rejects(
      withJitteredRetry(
        async () => {
          calls++
          throw Object.assign(new Error('overloaded'), { status: 503 })
        },
        {
          baseMs: 1,
          maxMs: 2,
          jitterRatio: 0,
          maxAttempts: 3,
          onRetry: () => retries++,
        },
      ),
      /overloaded/,
    )
    assert.equal(calls, 3)
    assert.equal(retries, 2)
  })

  it('non-retryable는 즉시 throw', async () => {
    let calls = 0
    await assert.rejects(
      withJitteredRetry(
        async () => {
          calls++
          throw Object.assign(new Error('unauthorized'), { status: 401 })
        },
        { baseMs: 1, maxMs: 2, jitterRatio: 0, maxAttempts: 3 },
      ),
      /unauthorized/,
    )
    assert.equal(calls, 1)
  })

  it('첫 retry에서 성공하면 그 결과 반환', async () => {
    let calls = 0
    const out = await withJitteredRetry(
      async () => {
        calls++
        if (calls === 1) throw Object.assign(new Error('rate'), { status: 429 })
        return 'ok'
      },
      { baseMs: 1, maxMs: 2, jitterRatio: 0, maxAttempts: 3 },
    )
    assert.equal(out, 'ok')
    assert.equal(calls, 2)
  })

  it('AbortSignal aborted면 즉시 중단', async () => {
    const ctl = new AbortController()
    let calls = 0
    const p = withJitteredRetry(
      async () => {
        calls++
        throw Object.assign(new Error('overloaded'), { status: 503 })
      },
      { baseMs: 50, maxMs: 100, jitterRatio: 0, maxAttempts: 5, signal: ctl.signal },
    )
    setTimeout(() => ctl.abort(), 10)
    await assert.rejects(p, /aborted/)
    assert.ok(calls >= 1 && calls < 5)
  })
})

describe('asyncIteratorWithFirstYieldRetry', () => {
  it('정상 stream → 모든 값 그대로 yield', async () => {
    const makeIter = async function* () {
      yield 1
      yield 2
      yield 3
    }
    const out = []
    for await (const v of asyncIteratorWithFirstYieldRetry(makeIter, { baseMs: 1, maxMs: 2, jitterRatio: 0 })) {
      out.push(v)
    }
    assert.deepEqual(out, [1, 2, 3])
  })

  it('첫 yield 전 retryable throw → retry 후 성공', async () => {
    let attempt = 0
    const makeIter = async function* () {
      attempt++
      if (attempt === 1) throw Object.assign(new Error('overloaded'), { status: 503 })
      yield 'ok'
    }
    const out = []
    for await (const v of asyncIteratorWithFirstYieldRetry(makeIter, {
      baseMs: 1,
      maxMs: 2,
      jitterRatio: 0,
      maxAttempts: 3,
    })) {
      out.push(v)
    }
    assert.deepEqual(out, ['ok'])
    assert.equal(attempt, 2)
  })

  it('첫 yield 후 throw → retry 없이 그대로 전파 (seq 정합 보장)', async () => {
    let attempt = 0
    const makeIter = async function* () {
      attempt++
      yield 'first'
      throw Object.assign(new Error('mid-stream overloaded'), { status: 503 })
    }
    const out = []
    await assert.rejects(async () => {
      for await (const v of asyncIteratorWithFirstYieldRetry(makeIter, {
        baseMs: 1,
        maxMs: 2,
        jitterRatio: 0,
        maxAttempts: 3,
      })) {
        out.push(v)
      }
    }, /mid-stream overloaded/)
    assert.deepEqual(out, ['first'])
    assert.equal(attempt, 1, 'iterator는 한 번만 생성되어야 함')
  })

  it('non-retryable는 첫 시도에서 즉시 throw', async () => {
    let attempt = 0
    const makeIter = async function* () {
      attempt++
      throw Object.assign(new Error('unauthorized'), { status: 401 })
    }
    await assert.rejects(async () => {
      for await (const _v of asyncIteratorWithFirstYieldRetry(makeIter, {
        baseMs: 1,
        maxMs: 2,
        jitterRatio: 0,
        maxAttempts: 3,
      })) { /* unreachable */ }
    }, /unauthorized/)
    assert.equal(attempt, 1)
  })
})

describe('DEFAULT_BACKOFF', () => {
  it('기본값은 daiops 환경에 맞춘 값 (base=2s, max=30s, 3회)', () => {
    assert.equal(DEFAULT_BACKOFF.baseMs, 2000)
    assert.equal(DEFAULT_BACKOFF.maxMs, 30000)
    assert.equal(DEFAULT_BACKOFF.maxAttempts, 3)
    assert.equal(DEFAULT_BACKOFF.jitterRatio, 0.5)
  })
})
