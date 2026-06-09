/**
 * Jittered exponential backoff + LLM 에러 분류.
 *
 * jittered backoff + error classifier 기반 재시도 전략.
 * - 같은 provider를 동시에 때리는 다중 세션이 동기화된 retry로 부담을 가중시키지 않도록
 *   thundering-herd를 random jitter로 분산
 * - retry할 에러는 일시적/회복 가능한 것만 (rate_limit, overloaded, 5xx, timeout)
 * - 영구 실패(billing, auth, 400 format)는 즉시 surface
 *
 * daiops 환경(agent-runner FETCH_TIMEOUT=750s, 단일 turn 시작 시 wrap)에 맞춰
 * base/max는 보수화 (base=2s, max=30s, 누적 3회 시도 ≈ 60s 이내).
 */

/** 기본 backoff 파라미터 */
export const DEFAULT_BACKOFF = Object.freeze({
  baseMs: 2000,
  maxMs: 30000,
  jitterRatio: 0.5,
  maxAttempts: 3,
})

/**
 * decorrelated exponential backoff with jitter.
 * attempt는 1부터 시작 (첫 retry).
 *
 * @param {number} attempt
 * @param {{baseMs?: number, maxMs?: number, jitterRatio?: number}} [opts]
 * @returns {number} sleep ms
 */
export function jitteredBackoff(attempt, opts = {}) {
  const baseMs = opts.baseMs ?? DEFAULT_BACKOFF.baseMs
  const maxMs = opts.maxMs ?? DEFAULT_BACKOFF.maxMs
  const jitterRatio = opts.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio
  const exp = Math.min(baseMs * Math.pow(2, Math.max(0, attempt - 1)), maxMs)
  const jitter = Math.random() * jitterRatio * exp
  return Math.floor(exp + jitter)
}

/**
 * 분류 결과.
 * - 'rate_limit'   : 429, "rate limit", "tokens per minute" — retry
 * - 'overloaded'   : 503/529, "overloaded" — retry
 * - 'server_error' : 500/502 — retry
 * - 'timeout'      : "timeout", "timed out", "ETIMEDOUT", "ECONNRESET" — retry
 * - 'billing'      : 402(크레딧 소진), "credit", "quota exhausted" — fatal
 *                    단, 402가 "usage limit ... try again/resets" 신호면 rate_limit(retryable)로 분리.
 * - 'auth'         : 401/403 — fatal
 * - 'context_overflow' : 400 + "prompt is too long"/"context length" — fatal (새 대화 유도)
 * - 'bad_request'  : 400 (format/validation) — fatal
 * - 'proxy_unreachable' : LLM proxy/터널 다운 (ERR_NGROK_3200, 404 offline) — fatal (인프라 결함)
 * - 'unknown'      : 분류 실패 — *retry 안 함* (보수적)
 *
 * proxy_unreachable·context_overflow는 daiops 고유(cloud LLM proxy + 긴 대화 구조)로,
 * hermes/openclaw 분류기에는 없으나 같은 "구조화 코드 전달" 원칙을 따른다.
 *
 * @param {unknown} err
 * @returns {{reason: string, retryable: boolean, status?: number}}
 */
/**
 * 402 disambiguation 패턴 — cloud src/lib/llm/error-classifier.ts와 동일(드리프트 금지).
 * usage-limit 신호 + transient 신호가 함께 있으면 "월 한도 일시 초과"로 보고 재시도한다.
 */
const USAGE_LIMIT_PATTERNS = ['usage limit', 'quota', 'limit exceeded', 'key limit exceeded']
const USAGE_LIMIT_TRANSIENT_SIGNALS = [
  'try again', 'retry', 'resets at', 'reset in', 'wait', 'requests remaining', 'periodic', 'window',
]

export function classifyLlmError(err) {
  const e = /** @type {{status?: number, statusCode?: number, code?: string, message?: string, name?: string, cause?: unknown}} */ (
    err && typeof err === 'object' ? err : {}
  )
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined
  const code = typeof e.code === 'string' ? e.code : ''
  const message = String(e.message ?? err ?? '').toLowerCase()
  const name = String(e.name ?? '').toLowerCase()

  // LLM proxy/dev 터널 다운 — status보다 먼저. ngrok 재시작으로 baked URL이 stale가 되면
  // proxy가 404 "endpoint ... is offline (ERR_NGROK_3200)"를 반환. retry해도 같은 죽은 URL이라 무의미.
  if (/err_ngrok|ngrok-free|is offline|endpoint .* is offline|tunnel .* not found/.test(message)) {
    return { reason: 'proxy_unreachable', retryable: false, status }
  }

  // 상태 코드 우선 (Anthropic SDK는 .status 노출)
  if (status === 429) return { reason: 'rate_limit', retryable: true, status }
  if (status === 402) {
    // 402는 두 갈래: 월 사용량 한도 초과(일시적, 곧 리셋) vs 크레딧 소진(영구).
    // "usage limit ... try again/resets" 신호가 함께 있으면 rate_limit로 재시도, 아니면 billing fatal.
    // (hermes _classify_402 차용, cloud error-classifier.ts:192-198과 동일 — 드리프트 금지)
    const hasUsageLimit = USAGE_LIMIT_PATTERNS.some((p) => message.includes(p))
    const hasTransient = USAGE_LIMIT_TRANSIENT_SIGNALS.some((p) => message.includes(p))
    if (hasUsageLimit && hasTransient) return { reason: 'rate_limit', retryable: true, status }
    return { reason: 'billing', retryable: false, status }
  }
  if (status === 401 || status === 403) return { reason: 'auth', retryable: false, status }
  // context window 초과 — 400의 한 갈래. bad_request보다 먼저 매칭해 사용자에게 "새 대화" 유도.
  if (status === 400 && /prompt is too long|context length|context window|maximum.*tokens|too many tokens/.test(message)) {
    return { reason: 'context_overflow', retryable: false, status }
  }
  if (status === 400) return { reason: 'bad_request', retryable: false, status }
  if (status === 503 || status === 529) return { reason: 'overloaded', retryable: true, status }
  if (status === 500 || status === 502 || status === 504) return { reason: 'server_error', retryable: true, status }

  // 네트워크 코드
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return { reason: 'timeout', retryable: true }
  }
  if (name === 'aborterror') return { reason: 'aborted', retryable: false }

  // 메시지 패턴 (SDK가 status 노출하지 않는 케이스 fallback)
  if (/rate.?limit|tokens per minute|too many requests/.test(message)) {
    return { reason: 'rate_limit', retryable: true }
  }
  if (/overloaded|temporarily unavailable/.test(message)) {
    return { reason: 'overloaded', retryable: true }
  }
  if (/timeout|timed out|deadline exceeded/.test(message)) {
    return { reason: 'timeout', retryable: true }
  }
  if (/credit|quota exhausted|insufficient/.test(message)) {
    return { reason: 'billing', retryable: false }
  }

  return { reason: 'unknown', retryable: false }
}

/** 시크릿 패턴 — 에러 detail을 cloud로 보내기 전 마스킹 (openhuman sanitize_api_error 차용) */
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{8,}/g, // OpenAI/Anthropic 키
  /eyJ[a-zA-Z0-9_=-]+\.[a-zA-Z0-9_=-]+\.[a-zA-Z0-9_=-]+/g, // JWT
  /ghp_[a-zA-Z0-9]{20,}/g, // GitHub PAT
  /AKIA[0-9A-Z]{16}/g, // AWS access key
]

/**
 * 에러를 cloud로 보낼 안전한 한 줄 요약으로 변환.
 * - message + body(있으면)를 합쳐 시크릿 마스킹 후 maxLen 절단.
 * - 스택·원문 전체는 포함하지 않는다 (handler.js catch에서 로그로만).
 *
 * @param {unknown} err
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeErrorDetail(err, maxLen = 200) {
  const e = /** @type {{message?: string, body?: unknown}} */ (err && typeof err === 'object' ? err : {})
  const body = typeof e.body === 'string' ? e.body : ''
  let detail = String(e.message ?? err ?? '')
  if (body && !detail.includes(body)) detail = `${detail} ${body}`
  detail = detail.replace(/\s+/g, ' ').trim()
  for (const pat of SECRET_PATTERNS) detail = detail.replace(pat, '[REDACTED]')
  return detail.slice(0, maxLen)
}

/**
 * `fn`을 호출하되, 분류 retryable + maxAttempts 안에서 jittered backoff로 재시도.
 *
 * **중요**: fn이 *한 번이라도 부분 결과를 emit한 후*에 throw하면 retry는 위험 (중복 emit).
 * 호출자가 fn 진입 직전~첫 yield 전까지만 retry되도록 정렬해야 함.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{baseMs?: number, maxMs?: number, jitterRatio?: number, maxAttempts?: number, onRetry?: (info: {attempt: number, delayMs: number, reason: string, status?: number}) => void, signal?: AbortSignal}} [opts]
 * @returns {Promise<T>}
 */
export async function withJitteredRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_BACKOFF.maxAttempts
  const signal = opts.signal
  let lastErr
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error('aborted')
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const cls = classifyLlmError(err)
      const isLast = attempt + 1 >= maxAttempts
      if (!cls.retryable || isLast) throw err
      const delayMs = jitteredBackoff(attempt + 1, opts)
      opts.onRetry?.({ attempt: attempt + 1, delayMs, reason: cls.reason, status: cls.status })
      await sleep(delayMs, signal)
    }
  }
  throw lastErr
}

/**
 * Async iterator를 *첫 yield까지*만 jittered retry로 감싼다.
 *
 * SDK는 stream이라 한 번이라도 message가 yield된 뒤 throw하면 *이미 SSE event를
 * emit한 상태일 수 있어* seq 중복/상태 오염 위험. 그래서 retry 영역은 엄격히
 * "iterator 생성 + 첫 next() await" 까지로 한정 — rate_limit/overloaded/network는
 * 거의 항상 이 구간에서 발생.
 *
 * @template T
 * @param {() => AsyncIterable<T> | AsyncIterator<T>} makeIter
 * @param {{baseMs?: number, maxMs?: number, jitterRatio?: number, maxAttempts?: number, onRetry?: (info: {attempt: number, delayMs: number, reason: string, status?: number}) => void, signal?: AbortSignal}} [opts]
 * @returns {AsyncGenerator<T>}
 */
export async function* asyncIteratorWithFirstYieldRetry(makeIter, opts = {}) {
  const { iter, first } = await withJitteredRetry(async () => {
    const candidate = makeIter()
    const newIter = /** @type {AsyncIterator<T>} */ (
      typeof (/** @type {{next?: unknown}} */ (candidate)).next === 'function'
        ? candidate
        : (/** @type {AsyncIterable<T>} */ (candidate))[Symbol.asyncIterator]()
    )
    let firstResult
    try {
      firstResult = await newIter.next()
    } catch (err) {
      try { await newIter.return?.() } catch { /* ignore */ }
      throw err
    }
    return { iter: newIter, first: firstResult }
  }, opts)

  if (first.done) return
  yield first.value
  let result = await iter.next()
  while (!result.done) {
    yield result.value
    result = await iter.next()
  }
}

/**
 * abort signal을 존중하는 sleep.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
