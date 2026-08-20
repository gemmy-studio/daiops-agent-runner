/**
 * 크레덴셜 주입 프록시 — 코어 치환 엔진 (Phase 1, 순수 로직·네트워크 없음).
 *
 * 목표: 샌드박스 안에는 placeholder(가짜 값)만 두고, 아웃바운드 요청이 **허용된 목적지로 나갈 때만**
 * 프록시가 placeholder를 진짜 값으로 치환한다. 에이전트가 `cat .integrations.env` / `echo $KEY`로
 * 값을 읽거나 훔쳐 나가도 가짜라 무용지물이다. (Agent Vault / vellum egress-proxy 모델)
 *
 * 설계 원칙:
 *  - placeholder는 `dai_phantom_<키이름>_<16hex>` — 고유·긴 문자열이라 일반 출력/토큰과 충돌하지 않는다.
 *    (문서에 오래 `<64hex>`로 적혀 있었으나 실제는 라벨+16hex다. 길이를 근거로 판정하면 어긋난다.)
 *  - host allowlist는 **fail-closed**: allowedHosts가 비면 어느 목적지로도 치환하지 않는다
 *    (진짜 값이 임의 호스트로 유출되는 것을 원천 차단 — 사용자가 설정에서 허용 호스트를 지정).
 *  - 치환은 요청의 헤더·URL·바디 어디서든(문자열 단위) 일어난다 — Agent Vault처럼 인증 스킴
 *    (Bearer/x-api-key/쿼리파라미터)을 하드코딩하지 않는다.
 */

import crypto from 'node:crypto'

/**
 * placeholder 접두사 — 로그/디버깅에서 식별 가능하고, 실제 값과 절대 겹치지 않도록.
 * ⚠️ cloud도 이 리터럴을 복제해 갖고 있다(`src/lib/integrations/secret-placeholder.ts`) —
 * 상시 프롬프트가 에이전트에게 접두사를 문자 그대로 인용해야 하기 때문. 바꾸면 양쪽을 같이 바꾼다.
 */
export const PLACEHOLDER_PREFIX = 'dai_phantom_'

/** placeholder 꼬리의 무작위 바이트 수 — 8바이트=16 hex(64비트). 고유성 확보용이지 비밀이 아니다. */
const PLACEHOLDER_RANDOM_BYTES = 8

/** 키 이름을 placeholder에 넣을 수 있는 형태로 정규화 (헤더·URL·셸에서 안전한 문자만, 길이 상한). */
function sanitizeKeyForPlaceholder(key) {
  return String(key ?? '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40)
}

/**
 * 새 placeholder 1개 생성 (부팅 시 secret당 1개).
 *
 * **키 이름을 담는다** — `dai_phantom_STRIPE_API_KEY_9f3ac1...`.
 * 종전에는 무작위 64 hex뿐이라, 이 값을 마주친 사람(과 에이전트)이 ① 가짜인지 ② 어떤 키의
 * 자리인지 둘 다 알 수 없었다. placeholder는 *비밀이 아니라 라벨*이므로 숨겨서 얻는 게 없고,
 * 키 이름은 어차피 환경변수 이름으로 드러나 있다. (Agent Vault의 `__github_token__` 모델)
 *
 * 무작위 꼬리는 고유성 전용이다 — 같은 키가 재기동될 때마다 다른 placeholder가 되어,
 * 과거 세션에서 새어 나간 문자열이 재사용되지 않는다.
 *
 * @param {string} key 환경변수 키 (예: STRIPE_API_KEY)
 * @returns {string} `dai_phantom_<KEY>_<16hex>`
 */
export function generatePlaceholder(key) {
  const label = sanitizeKeyForPlaceholder(key)
  const rand = crypto.randomBytes(PLACEHOLDER_RANDOM_BYTES).toString('hex')
  return label ? `${PLACEHOLDER_PREFIX}${label}_${rand}` : PLACEHOLDER_PREFIX + rand
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
 * **injectionMap은 placeholder가 긴 것부터 담긴다(불변식).** placeholder가 키 이름을 담게 되면서
 * (예: `..._A_<hex>` vs `..._A_B_<hex>`) 이론상 한쪽이 다른 쪽의 부분문자열이 될 수 있는데,
 * 짧은 것을 먼저 치환하면 긴 placeholder를 조각내 망가뜨린다. 삽입 순서로 한 번만 정해 두면
 * 요청마다 정렬할 필요가 없다(치환은 헤더마다 도는 hot path).
 *
 * @param {MaterializedSecret[]} secrets
 * @returns {{ placeholderByKey: Map<string,string>, injectionMap: Map<string,InjectionEntry> }}
 */
export function buildInjectionMap(secrets) {
  /** @type {Map<string,string>} */
  const placeholderByKey = new Map()
  /** @type {Array<[string, InjectionEntry]>} */
  const entries = []

  for (const s of Array.isArray(secrets) ? secrets : []) {
    if (!s || typeof s.key !== 'string' || typeof s.realValue !== 'string') continue
    if (!s.key || !s.realValue) continue
    const placeholder = generatePlaceholder(s.key)
    const allowedHosts = Array.isArray(s.allowedHosts)
      ? s.allowedHosts.filter((h) => typeof h === 'string' && h.length > 0)
      : []
    placeholderByKey.set(s.key, placeholder)
    entries.push([placeholder, { key: s.key, realValue: s.realValue, allowedHosts }])
  }

  entries.sort((a, b) => b[0].length - a[0].length)
  return { placeholderByKey, injectionMap: new Map(entries) }
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
 * URL(경로+쿼리)에 대한 치환 — **percent-encoding을 적용한다.** 헤더·바디와 다른 함수인 이유가 이것이다.
 *
 * 진짜 값에 `+` `/` `=` 가 섞여 있으면 URL에서는 **구분자로 읽힌다** — 쿼리스트링의 `+`는 공백이다.
 * 실사고(2026-08-20): 공공데이터포털 서비스키(base64라 `+/=` 포함)를 쿼리에 실었는데 raw 치환이라
 * 받는 쪽에서 키가 깨져 "등록되지 않은 서비스키" 403이 났다. 헤더로 쓰는 키는 멀쩡했으므로
 * "키가 틀렸다"로 오래 오진됐다 — **표면마다 증상이 다른 것이 이 결함의 성질이다.**
 *
 * 설계는 Agent Vault(`internal/brokercore/substitution.go`)와 같다: 경로·쿼리는 percent-encode,
 * 헤더는 raw(+CRLF 가드), 바디는 content-type별. 쿼리는 **전체를 재직렬화하지 않고** placeholder
 * 자리만 바꾼다 — 우리가 만들지 않은 다른 파라미터의 인코딩을 보존해야 서명 기반 API가 깨지지 않는다.
 *
 * placeholder 자체는 `[A-Za-z0-9_]`(RFC 3986 unreserved)라 인코딩 전후 형태가 같다. 그래서 wire
 * 형태의 문자열에서 그대로 찾을 수 있다 — 이 전제가 깨지면(접두사·라벨 문자 확대) 매칭이 조용히 끊긴다.
 *
 * @param {string} pathWithQuery — 요청 라인의 경로(`/a/b?x=y`)
 * @param {string} host
 * @param {Map<string,InjectionEntry>} injectionMap
 * @returns {{ text: string, substituted: string[] }}
 */
export function substituteInUrl(pathWithQuery, host, injectionMap) {
  const s = typeof pathWithQuery === 'string' ? pathWithQuery : ''
  const substituted = new Set()
  if (!s || !injectionMap || injectionMap.size === 0) return { text: s, substituted: [] }

  const q = s.indexOf('?')
  let pathPart = q === -1 ? s : s.slice(0, q)
  let queryPart = q === -1 ? '' : s.slice(q + 1)

  for (const [placeholder, entry] of injectionMap) {
    const inPath = pathPart.includes(placeholder)
    const inQuery = queryPart.includes(placeholder)
    if (!inPath && !inQuery) continue
    if (!isHostAllowed(host, entry.allowedHosts)) continue // fail-closed
    // 경로 세그먼트 안의 값도 `/`가 살아 있으면 경로가 갈라지므로 같은 인코더를 쓴다.
    const encoded = encodeURIComponent(entry.realValue)
    if (inPath) pathPart = pathPart.split(placeholder).join(encoded)
    if (inQuery) queryPart = queryPart.split(placeholder).join(encoded)
    substituted.add(entry.key)
  }

  return { text: q === -1 ? pathPart : `${pathPart}?${queryPart}`, substituted: [...substituted] }
}

/** JSON 문자열 리터럴 안에 넣을 수 있게 이스케이프(따옴표를 벗긴다). */
function jsonEscape(value) {
  const s = JSON.stringify(String(value))
  return s.slice(1, -1)
}

/**
 * 요청 바디에 대한 치환 — **content-type에 맞는 인코딩**을 쓴다.
 *
 * 값에 따옴표·역슬래시가 있으면 JSON 바디가 깨지고, `&`·`=`가 있으면 form 바디의 필드 경계가
 * 무너진다. multipart는 경계 문자열을 훼손할 위험이 있어 손대지 않는다(Agent Vault와 동일한 판단).
 *
 * @param {string} text — 바디 원문
 * @param {string} contentType — 요청의 `content-type` 헤더(없으면 빈 문자열)
 * @param {string} host
 * @param {Map<string,InjectionEntry>} injectionMap
 * @returns {{ text: string, substituted: string[], skipped: boolean }}
 */
export function substituteInBody(text, contentType, host, injectionMap) {
  let s = typeof text === 'string' ? text : ''
  const substituted = []
  if (!s || !injectionMap || injectionMap.size === 0) return { text: s, substituted, skipped: false }

  // `application/json; charset=utf-8` 처럼 매개변수가 붙으므로 미디어 타입만 떼어 소문자로 본다.
  const media = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (media.startsWith('multipart/')) return { text: s, substituted, skipped: true }

  const encode =
    media === 'application/x-www-form-urlencoded' ? encodeURIComponent
    : media === 'application/json' ? jsonEscape
    : (v) => v

  for (const [placeholder, entry] of injectionMap) {
    if (!s.includes(placeholder)) continue
    if (!isHostAllowed(host, entry.allowedHosts)) continue // fail-closed
    s = s.split(placeholder).join(encode(entry.realValue))
    substituted.push(entry.key)
  }
  return { text: s, substituted, skipped: false }
}

/**
 * 헤더 객체 전체에 대해 치환 — 얕은 복사본 반환(원본 불변). 헤더 값은 **raw**로 넣는다
 * (percent-encoding을 하면 `Authorization: Basic <base64>` 같은 값이 오히려 깨진다).
 *
 * 다만 값에 CR·LF가 있으면 **치환하지 않는다** — 그대로 넣으면 헤더를 하나 더 만들어 붙이는
 * 헤더 인젝션이 된다. 호스트 불허와 같은 fail-closed 처리라, placeholder가 남은 채 나가고
 * 업스트림이 인증에 실패한다(Agent Vault는 여기서 요청 자체를 거부한다 — 우리는 기존 정책과
 * 일관되게 '치환 안 함'을 택했다).
 *
 * @param {Record<string,string>} headers
 * @param {string} host
 * @param {Map<string,InjectionEntry>} injectionMap
 * @returns {{ headers: Record<string,string>, substituted: string[], rejected: string[] }}
 */
export function substituteHeaders(headers, host, injectionMap) {
  /** @type {Record<string,string>} */
  const out = {}
  const substituted = new Set()
  const rejected = new Set()
  for (const [k, v] of Object.entries(headers ?? {})) {
    let s = String(v ?? '')
    if (s && injectionMap && injectionMap.size > 0) {
      for (const [placeholder, entry] of injectionMap) {
        if (!s.includes(placeholder)) continue
        if (!isHostAllowed(host, entry.allowedHosts)) continue // fail-closed
        if (/[\r\n]/.test(entry.realValue)) {
          rejected.add(entry.key) // 헤더 인젝션 가드 — placeholder를 그대로 둔다
          continue
        }
        s = s.split(placeholder).join(entry.realValue)
        substituted.add(entry.key)
      }
    }
    out[k] = s
  }
  return { headers: out, substituted: [...substituted], rejected: [...rejected] }
}

/**
 * placeholder 토큰 1개를 통째로 잡는 정규식. label은 `[A-Za-z0-9_]`, 꼬리는 소문자 hex 16자.
 * 전역 플래그 정규식은 `lastIndex`가 남으므로 호출마다 새로 만든다.
 */
function placeholderTokenRegex() {
  return new RegExp(`${PLACEHOLDER_PREFIX}[A-Za-z0-9_]+`, 'g')
}

/**
 * 텍스트에 섞인 placeholder를 `<placeholder:KEY>` 라벨로 바꾼다. **표시 전용.**
 *
 * ## 왜 필요한가
 *
 * placeholder는 비밀이 아니라서 값 기반 마스킹(`maskSecretValues`)의 대상이 아니다. 그래서
 * `echo $STRIPE_API_KEY`의 결과가 아무 표식 없이 도구 출력 → 채팅 버블로 그대로 흘렀고,
 * 사용자는 그게 자기 키인지 시스템이 만든 가짜인지 구분할 수 없었다. 모델도 마찬가지라
 * "키 알려줘"에 이 문자열을 진짜 키처럼 답했다.
 *
 * 도구 출력 단계에서 라벨로 바꾸면 **모델이 애초에 원문 placeholder를 손에 넣지 못한다** —
 * 그래서 답변에 옮겨 적는 것도 자동으로 막힌다. (1Password `op run`의 `<concealed by 1Password>`)
 *
 * ## 하지 말아야 할 것
 *
 * **아웃바운드 요청 경로에는 절대 적용하지 않는다.** 프록시는 원문 placeholder를 문자 그대로
 * 찾아 치환하므로, 요청 헤더·바디를 라벨로 바꿔 버리면 실값 주입이 통째로 실패한다.
 * 이 함수는 "사람·모델에게 보여줄 텍스트"에만 쓴다.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function maskPlaceholders(text) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (!s || !s.includes(PLACEHOLDER_PREFIX)) return s
  return s.replace(placeholderTokenRegex(), (token) => {
    const rest = token.slice(PLACEHOLDER_PREFIX.length)
    const m = rest.match(/^(.*)_([0-9a-f]{16})$/)
    const label = m ? m[1] : ''
    return label ? `<placeholder:${label}>` : '<placeholder>'
  })
}

/** 프록시가 "허용 호스트가 아니라 막았다"를 알릴 때 쓰는 오류 코드. 러너·cloud·프롬프트가 공유한다. */
export const SECRET_HOST_NOT_ALLOWED = 'secret_host_not_allowed'

/**
 * 도구 출력에 섞여 들어온 프록시 차단 응답을 찾아낸다.
 *
 * 차단은 프록시가 자식 프로세스(curl·python 등)에 403 JSON으로 돌려주므로, 러너 본체는 그 사건을
 * 직접 볼 수 없다. 유일한 흔적이 **도구 출력 문자열**이다. 여기서 건져 올려야 사용자에게
 * "어떤 시크릿이 어느 호스트에서 막혔다"를 구조화해 보여줄 수 있다 — 그러지 않으면 에이전트가
 * 임의로 요약한 "인증에 실패했습니다"만 남는다.
 *
 * @param {unknown} text 도구 출력
 * @returns {{ secrets: string[], host: string } | null}
 */
export function detectSecretBlockNotice(text) {
  const s = typeof text === 'string' ? text : ''
  if (!s.includes(SECRET_HOST_NOT_ALLOWED)) return null
  // 프록시가 만드는 평평한 JSON 오브젝트 하나를 집는다(중첩 없음 — 우리가 만든 형식이라 확정적).
  const m = s.match(/\{[^{}]*"error"\s*:\s*"secret_host_not_allowed"[^{}]*\}/)
  if (!m) return null
  try {
    const parsed = JSON.parse(m[0])
    const secrets = Array.isArray(parsed.secrets)
      ? parsed.secrets.filter((k) => typeof k === 'string' && k)
      : typeof parsed.secret === 'string' && parsed.secret
        ? [parsed.secret]
        : []
    const host = typeof parsed.host === 'string' ? parsed.host : ''
    if (secrets.length === 0 || !host) return null
    return { secrets, host }
  } catch {
    return null
  }
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
