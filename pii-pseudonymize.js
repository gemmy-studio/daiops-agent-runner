/**
 * 개인정보 가명화 — 도구 결과가 모델 컨텍스트에 들어가기 **전에** 고유식별번호를 토큰으로 바꾼다.
 *
 * ## 왜 출력 필터로 부족한가
 *
 * cloud(lattice)에는 답변을 내보내기 전에 거는 출력 필터가 이미 있다. 그런데 그것은 **번호
 * 형태**만 잡는다. 모델이 `880101-1234567`을 보고 "88년 1월생 남성입니다"라고 풀어 쓰면
 * 출력 필터는 잡을 수 없다 — 번호가 아니기 때문이다.
 *
 * 모델이 애초에 원본을 못 보면 어떤 형태로도 못 흘린다. 그래서 입력측에서 한 번 더 자른다.
 *
 * ## 지우지 않고 **가명화**하는 이유
 *
 * 등기부등본에서 주민등록번호 앞자리는 **동명이인 임원을 가르는 유일한 단서**일 때가 있다.
 * 통째로 지우면 "김철수 이사가 두 명"을 구분하지 못해 판독이 틀린다. 같은 값에 같은 토큰을
 * 주면 식별은 유지되고 원본만 사라진다(hermes `gateway/session.py` 의 결정론적 해시와 같은 취지).
 *
 * ## 한계 — 여기서 못 막는 것
 *
 * - **이미지 판독 경로.** 등기부등본은 `readingHint` 가 "반드시 이미지로 판독"을 지시하는데,
 *   픽셀은 텍스트 필터가 손댈 수 없다. 그 경로는 cloud 출력 필터가 유일한 방어다.
 * - **MCP 도구 결과.** turn-manager 가 자체 라우팅해 이 자리를 지나지 않는다(llm-wrapper 주석).
 * - **산문형 개인정보.** "서울 강남 사는 88년생" 같은 서술은 패턴이 없다.
 *
 * 세 가지 모두 다른 층이 덮는다. 여기서 다 하려 하지 말 것.
 */

/** 가명화 대상. cloud(lattice) `src/lib/ai/pii/recognizers.ts` 에서 **복사·이식**했다(별개 레포). */
export const PII_RECOGNIZERS = [
  {
    type: 'rrn',
    label: '주민등록번호',
    pattern: /(?<![0-9])(\d{6})[\s-–—]{0,3}([0-9]\d{6})(?![0-9])/g,
    verify: (m) => classifyRegistrationNumber(m) === 'rrn',
  },
  {
    type: 'frn',
    label: '외국인등록번호',
    pattern: /(?<![0-9])(\d{6})[\s-–—]{0,3}([0-9]\d{6})(?![0-9])/g,
    verify: (m) => classifyRegistrationNumber(m) === 'frn',
  },
  {
    type: 'card',
    label: '카드번호',
    pattern: /(?<![0-9])(?:\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{1,7}|\d{13,19})(?![0-9])/g,
    verify: (m) => luhnOk(m[0].replace(/\D/g, '')),
  },
  {
    type: 'passport',
    label: '여권번호',
    pattern: /(?<![A-Za-z0-9])[MSRODGmsrodg]\d{8}(?![A-Za-z0-9])/g,
  },
]

/** 기본 적용 대상 — cloud 봉투가 목록을 주지 않을 때 쓴다(1단계는 항상 이것). */
export const DEFAULT_PII_TYPES = PII_RECOGNIZERS.map((r) => r.type)

function isPlausibleYymmdd(s) {
  const mm = Number(s.slice(2, 4))
  const dd = Number(s.slice(4, 6))
  if (mm < 1 || mm > 12) return false
  if (dd < 1 || dd > 31) return false
  return dd <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1]
}

function rrnChecksumOk(digits) {
  if (digits.length !== 13) return false
  const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5]
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * weights[i]
  return (11 - (sum % 11)) % 10 === Number(digits[12])
}

function luhnOk(digits) {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i])
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/**
 * 7번째 자리가 국적·세기를 가른다 — 1·2·3·4·9·0 = 내국인, 5·6·7·8 = 외국인.
 *
 * 하이픈 형태는 검증식 없이 통과시킨다. 스캔본 등기부등본은 텍스트 추출에서 숫자 한 자가
 * 어긋나기 쉬운데, 검증식을 요구하면 **가장 위험한 문서에서 가장 잘 샌다.** 하이픈이 없으면
 * 다른 13자리(계좌 등)일 수 있어 연속 13자리 + 검증식을 모두 요구한다.
 */
function classifyRegistrationNumber(match) {
  const raw = match[0]
  const front = match[1]
  const back = match[2]
  if (!isPlausibleYymmdd(front)) return null
  const gender = Number(back[0])
  const isForeign = gender >= 5 && gender <= 8
  const isDomestic = gender <= 4 || gender === 9 || gender === 0
  if (!isForeign && !isDomestic) return null
  const hyphenated = /[-–—]/.test(raw)
  const contiguous = raw.length === 13
  if (!hyphenated && !(contiguous && rrnChecksumOk(front + back))) return null
  return isForeign ? 'frn' : 'rrn'
}

/**
 * 세션 단위 가명 대장.
 *
 * 🔒 **원본 → 토큰 매핑을 들고 있다.** 로그·응답·디스크 어디에도 내보내지 않는다.
 * 잡이 끝나면 함께 사라지는 메모리 객체로만 존재한다.
 */
export function createPseudonymRegistry() {
  return { map: new Map(), counters: new Map() }
}

function tokenFor(registry, type, label, raw) {
  const key = `${type}:${raw.replace(/\D/g, '')}`
  const existing = registry.map.get(key)
  if (existing) return existing
  const next = (registry.counters.get(type) ?? 0) + 1
  registry.counters.set(type, next)
  const token = `[${label}#${next}]`
  registry.map.set(key, token)
  return token
}

/**
 * 텍스트의 고유식별번호를 가명 토큰으로 바꾼다.
 *
 * @param {string} text
 * @param {{ registry: ReturnType<typeof createPseudonymRegistry>, types?: string[] }} opts
 * @returns {{ text: string, counts: Record<string, number> }}
 */
export function pseudonymizePii(text, opts) {
  if (typeof text !== 'string' || text.length === 0) return { text, counts: {} }
  const enabled = new Set(opts?.types ?? DEFAULT_PII_TYPES)
  const registry = opts?.registry ?? createPseudonymRegistry()

  // 겹치는 매치는 레지스트리 순서(우선순위)로 하나만 남긴다 — 하이픈 없는 13자리 주민번호는
  // 카드번호 패턴에도 걸린다.
  const found = []
  PII_RECOGNIZERS.forEach((recognizer, priority) => {
    if (!enabled.has(recognizer.type)) return
    recognizer.pattern.lastIndex = 0
    let m
    while ((m = recognizer.pattern.exec(text)) !== null) {
      if (m[0].length === 0) {
        recognizer.pattern.lastIndex += 1
        continue
      }
      if (recognizer.verify && !recognizer.verify(m)) continue
      found.push({ recognizer, start: m.index, end: m.index + m[0].length, raw: m[0], priority })
    }
  })
  found.sort((a, b) => a.start - b.start || a.priority - b.priority)

  const counts = {}
  let out = ''
  let cursor = 0
  for (const hit of found) {
    if (hit.start < cursor) continue
    const { type, label } = hit.recognizer
    counts[type] = (counts[type] ?? 0) + 1
    out += text.slice(cursor, hit.start) + tokenFor(registry, type, label, hit.raw)
    cursor = hit.end
  }
  return { text: out + text.slice(cursor), counts }
}
