/**
 * 크레덴셜 주입 프록시 — 코어 치환 엔진 (Phase 1, 순수 로직·네트워크 없음).
 *
 * 목표: 샌드박스 안에는 placeholder(가짜 값)만 두고, 아웃바운드 요청이 **허용된 목적지로 나갈 때만**
 * 프록시가 placeholder를 진짜 값으로 치환한다. 에이전트가 `cat .integrations.env` / `echo $KEY`로
 * 값을 읽거나 훔쳐 나가도 가짜라 무용지물이다. (Agent Vault / vellum egress-proxy 모델)
 *
 * 설계 원칙:
 *  - placeholder는 `dai_phantom_<64hex>` — 고유·긴 문자열이라 일반 출력/토큰과 충돌하지 않는다.
 *  - host allowlist는 **fail-closed**: allowedHosts가 비면 어느 목적지로도 치환하지 않는다
 *    (진짜 값이 임의 호스트로 유출되는 것을 원천 차단 — 사용자가 설정에서 허용 호스트를 지정).
 *  - 치환은 요청의 헤더·URL·바디 어디서든(문자열 단위) 일어난다 — Agent Vault처럼 인증 스킴
 *    (Bearer/x-api-key/쿼리파라미터)을 하드코딩하지 않는다.
 */

import crypto from 'node:crypto'

/** placeholder 접두사 — 로그/디버깅에서 식별 가능하고, 실제 값과 절대 겹치지 않도록. */
export const PLACEHOLDER_PREFIX = 'dai_phantom_'

/**
 * 새 placeholder 1개 생성 (부팅 시 secret당 1개).
 * @returns {string} `dai_phantom_` + 64 hex
 */
export function generatePlaceholder() {
  return PLACEHOLDER_PREFIX + crypto.randomBytes(32).toString('hex')
}

/**
 * @typedef {Object} MaterializedSecret
 * @property {string} key — 환경변수 키 (예: STRIPE_API_KEY)
 * @property {string} realValue — 진짜 값 (평문 — 프록시 프로세스 메모리에만 존재)
 * @property {string[]} [allowedHosts] — 치환을 허용할 호스트 목록 (예: ['api.stripe.com', '*.internal.corp'])
 */

/**
 * @typedef {Object} InjectionEntry
 * @property {string} key
 * @property {string} realValue
 * @property {string[]} allowedHosts
 */

/**
 * 부팅 시 materialize 결과로 주입 맵을 구성한다.
 * placeholder는 여기서 생성되므로, 반환된 placeholderByKey로 `.integrations.env`를 쓰고
 * injectionMap으로 치환한다 — 둘이 항상 같은 placeholder를 공유한다.
 *
 * @param {MaterializedSecret[]} secrets
 * @returns {{ placeholderByKey: Map<string,string>, injectionMap: Map<string,InjectionEntry> }}
 */
export function buildInjectionMap(secrets) {
  /** @type {Map<string,string>} */
  const placeholderByKey = new Map()
  /** @type {Map<string,InjectionEntry>} */
  const injectionMap = new Map()

  for (const s of Array.isArray(secrets) ? secrets : []) {
    if (!s || typeof s.key !== 'string' || typeof s.realValue !== 'string') continue
    if (!s.key || !s.realValue) continue
    const placeholder = generatePlaceholder()
    const allowedHosts = Array.isArray(s.allowedHosts)
      ? s.allowedHosts.filter((h) => typeof h === 'string' && h.length > 0)
      : []
    placeholderByKey.set(s.key, placeholder)
    injectionMap.set(placeholder, { key: s.key, realValue: s.realValue, allowedHosts })
  }

  return { placeholderByKey, injectionMap }
}

/**
 * 호스트 하나를 정규화 — 소문자, 포트/후행점 제거.
 * @param {string} host
 * @returns {string}
 */
function normalizeHost(host) {
  if (typeof host !== 'string') return ''
  let h = host.trim().toLowerCase()
  // 포트 제거 (IPv6 `[::1]:443`은 단순화상 대괄호 내부만 취함)
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end > 0 ? h.slice(1, end) : h
  }
  const colon = h.indexOf(':')
  if (colon >= 0) h = h.slice(0, colon)
  if (h.endsWith('.')) h = h.slice(0, -1)
  return h
}

/**
 * 요청 목적지 host가 allowedHosts에 해당하는지 검사.
 * - 정확 일치: 'api.stripe.com'
 * - 서브도메인 와일드카드: '*.example.com' → 'a.example.com' 일치 (단 'example.com' 자체는 불일치)
 * - **fail-closed**: allowedHosts가 비면 항상 false (치환 안 함).
 *
 * @param {string} host
 * @param {string[]} allowedHosts
 * @returns {boolean}
 */
export function isHostAllowed(host, allowedHosts) {
  const h = normalizeHost(host)
  if (!h) return false
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return false
  for (const raw of allowedHosts) {
    const pattern = normalizeHost(raw.startsWith('*.') ? raw.slice(2) : raw)
    if (!pattern) continue
    if (raw.startsWith('*.')) {
      // 서브도메인만 (부모 도메인 자체는 제외)
      if (h.endsWith('.' + pattern)) return true
    } else if (h === pattern) {
      return true
    }
  }
  return false
}

/**
 * 문자열(헤더 값·URL·바디)에서 placeholder를 진짜 값으로 치환 —
 * 단, 그 placeholder의 allowedHosts에 목적지 host가 포함될 때만.
 * 허용되지 않으면 placeholder를 그대로 둔다 → 업스트림이 가짜 값을 받아 인증 실패(안전).
 *
 * @param {string} text
 * @param {string} host — 요청 목적지 호스트
 * @param {Map<string,InjectionEntry>} injectionMap
 * @returns {{ text: string, substituted: string[] }} 치환된 키 목록(감사/로그용, 값은 미포함)
 */
export function substituteInText(text, host, injectionMap) {
  let s = typeof text === 'string' ? text : ''
  const substituted = []
  if (!s || !injectionMap || injectionMap.size === 0) return { text: s, substituted }

  for (const [placeholder, entry] of injectionMap) {
    if (!s.includes(placeholder)) continue
    if (!isHostAllowed(host, entry.allowedHosts)) continue // fail-closed
    s = s.split(placeholder).join(entry.realValue)
    substituted.push(entry.key)
  }
  return { text: s, substituted }
}

/**
 * 헤더 객체 전체에 대해 치환 — 얕은 복사본 반환(원본 불변).
 * @param {Record<string,string>} headers
 * @param {string} host
 * @param {Map<string,InjectionEntry>} injectionMap
 * @returns {{ headers: Record<string,string>, substituted: string[] }}
 */
export function substituteHeaders(headers, host, injectionMap) {
  /** @type {Record<string,string>} */
  const out = {}
  const substituted = new Set()
  for (const [k, v] of Object.entries(headers ?? {})) {
    const r = substituteInText(String(v ?? ''), host, injectionMap)
    out[k] = r.text
    for (const key of r.substituted) substituted.add(key)
  }
  return { headers: out, substituted: [...substituted] }
}

/**
 * 요청(헤더 값·URL·바디)에 존재하지만 목적지 host가 allowedHosts에 없어 치환이 막히는
 * placeholder들을 찾아낸다.
 *
 * 이런 요청은 placeholder를 그대로 업스트림에 흘리면 (a) 진짜 시크릿을 쓰려던 요청이 단순
 * 인증 실패(401)로 나타나 원인 파악이 어렵고, (b) placeholder 자체가 미허용 호스트로 샌다.
 * 프록시는 이 결과로 요청을 차단하고 "허용 호스트 미지정"을 명확히 알린다(fail-closed 유지).
 *
 * @param {string[]} texts — 검사할 문자열들(헤더 값·path·body 등)
 * @param {string} host — 요청 목적지 호스트
 * @param {Map<string,InjectionEntry>} injectionMap
 * @returns {{ key: string, allowedHosts: string[] }[]} 차단된 시크릿(값 미포함)
 */
export function detectBlockedSecrets(texts, host, injectionMap) {
  /** @type {{ key: string, allowedHosts: string[] }[]} */
  const blocked = []
  if (!injectionMap || injectionMap.size === 0) return blocked
  const list = Array.isArray(texts) ? texts.filter((t) => typeof t === 'string' && t) : []
  if (list.length === 0) return blocked
  for (const [placeholder, entry] of injectionMap) {
    if (!list.some((t) => t.includes(placeholder))) continue
    if (isHostAllowed(host, entry.allowedHosts)) continue // 허용된 목적지면 정상 치환 — 차단 아님
    blocked.push({ key: entry.key, allowedHosts: entry.allowedHosts })
  }
  return blocked
}
