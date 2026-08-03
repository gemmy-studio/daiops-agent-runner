/**
 * validate-schema — 의존성 0 미니멀 JSON Schema 검증기 (구조화 출력 response_schema용).
 *
 * agent-runner는 `"dependencies": {}` (의존성 0) 원칙이라 ajv 등 외부 검증기를 쓸 수 없다.
 * 여기서는 forced tool_choice로 이미 형태가 대체로 맞춰진 tool input을 "총체적 위반"만 걸러
 * 재시도를 트리거할 수 있을 만큼만 검증한다. 전체 JSON Schema 스펙 준수가 목표가 아니다.
 *
 * 지원 키워드(부분집합):
 *  - type: 'object'|'array'|'string'|'number'|'integer'|'boolean'|'null' (또는 그 배열)
 *  - properties (object 재귀), required (누락 검사)
 *  - items (array 원소 재귀 — 단일 스키마), enum, const
 *  - additionalProperties: false (properties 밖 키 거부)
 *  - anyOf (하나라도 통과) / allOf (모두 통과) / oneOf (정확히 하나 통과)
 *  - $ref (#/$defs/… · #/definitions/… JSON 포인터를 root에서 해석) — codegen(zod/pydantic) 스키마 대응
 *  - maxLength · minLength (문자열) / maxItems · minItems (배열) / maximum · minimum (숫자)
 * 미지원 키워드(pattern·uniqueItems·multipleOf·exclusiveMinimum/Maximum 등)는 무시 — 통과로 간주.
 *
 * ## 길이·개수·범위를 뒤늦게 넣은 이유 (2026-08-04)
 *
 * 이 검증기가 없는 키워드를 조용히 통과시키므로, 호출자가 스키마에 적어 둔 상한이
 * **집행되지 않는 장식**이 된다. 실제로 그런 상태가 발견됐다 — Lattice 가 `maxItems: 9`
 * (9항목 고정 평가)·`maximum: 1`(유사도 0~1)을 주석에 "고정한다"고 적어 두고 심었는데
 * 아무것도 강제되지 않고 있었다. 형식 위반은 잡히고 길이 위반은 안 잡히는 비대칭이
 * 호출자에게 보이지 않는 것이 문제의 핵심이다.
 *
 * 이 여섯 개는 **판정이 결정론적이고 비용이 상수**라 "총체적 위반만 걸러 재시도를
 * 트리거한다"는 이 파일의 설계 철학에 맞는다.
 *
 * ## `pattern` 을 넣지 않은 이유 (의도된 제외)
 *
 * 정규식은 **패턴이 호출자에게서, 검사 대상 문자열이 LLM 에서** 온다. 그 조합은 파국적
 * 백트래킹(ReDoS)에 노출되고, 동기 검증기에는 시간 상한을 걸 수단이 없어 이벤트 루프가
 * 묶인다. 재시도 루프 안에서 실행되므로 한 번 걸리면 반복된다. 길이·개수와 달리 비용이
 * 입력에 지수적일 수 있는 유일한 키워드다.
 *
 * 실제 필요가 생기면 그때 안전 장치(패턴 화이트리스트 또는 별도 워커의 시간 상한)와
 * 함께 넣는다. 지금 넣으면 안전 장치 없이 들어간다.
 */

/** $ref 사이클/과심층 방어 상한. 초과 시 검증 포기(통과) — 그로스 위반만 거른다는 설계 철학 유지. */
const MAX_VALIDATION_DEPTH = 100

/**
 * @param {unknown} schema
 * @param {unknown} value
 * @param {string} [path]
 * @param {any} [root] - $ref 해석 기준(최초 스키마). 재귀에서 관통.
 * @param {number} [depth] - 사이클 방어용 재귀 깊이.
 * @returns {string[]} 위반 메시지 목록 (빈 배열이면 통과)
 */
export function collectSchemaErrors(schema, value, path = '$', root = undefined, depth = 0) {
  if (!schema || typeof schema !== 'object') return []
  if (root === undefined) root = schema
  // $ref 사이클(자기참조 스키마 등)에서 값이 소비되지 않으면 무한 재귀 → 상한 초과 시 검증 포기.
  if (depth > MAX_VALIDATION_DEPTH) return []
  /** @type {Record<string, any>} */
  const s = schema

  // $ref — root의 $defs/definitions 등을 JSON 포인터로 해석해 재귀. draft-07처럼 $ref 형제 키워드는 무시.
  if (typeof s.$ref === 'string') {
    const resolved = resolveRef(root, s.$ref)
    // 해석 불가한 ref는 검증 불가 → 통과(그로스 위반만 목표, false negative 방지).
    if (!resolved || typeof resolved !== 'object') return []
    return collectSchemaErrors(resolved, value, path, root, depth + 1)
  }

  // anyOf — 하나라도 통과하면 OK.
  if (Array.isArray(s.anyOf)) {
    const anyOk = s.anyOf.some((sub) => collectSchemaErrors(sub, value, path, root, depth + 1).length === 0)
    if (!anyOk) return [`${path}: does not match any of the allowed schemas`]
    return []
  }

  // oneOf — 정확히 하나만 통과해야 OK.
  if (Array.isArray(s.oneOf)) {
    const passCount = s.oneOf.filter(
      (sub) => collectSchemaErrors(sub, value, path, root, depth + 1).length === 0,
    ).length
    if (passCount !== 1) return [`${path}: must match exactly one schema (matched ${passCount})`]
    return []
  }

  /** @type {string[]} */
  const errors = []

  // allOf — 모든 하위 스키마를 만족해야 함. 실패 시 형제 검사는 무의미하니 조기 반환.
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) {
      errors.push(...collectSchemaErrors(sub, value, path, root, depth + 1))
    }
    if (errors.length) return errors
  }

  // const
  if ('const' in s && !deepEqual(value, s.const)) {
    errors.push(`${path}: must equal ${JSON.stringify(s.const)}`)
  }

  // enum
  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(s.enum)}`)
  }

  // type
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    if (!types.some((t) => matchesType(t, value))) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${jsonType(value)}`)
      // 타입 불일치면 하위 검증은 의미 없으니 조기 반환.
      return errors
    }
  }

  // string: maxLength / minLength
  //
  // JSON Schema 는 길이를 **코드 포인트**로 센다(UTF-16 코드 단위가 아니다). 이모지 등
  // 서로게이트 쌍이 있으면 코드 포인트가 더 적으므로, 코드 단위로 세는 소비자(JS
  // `str.length`·zod `.max()`)보다 **관대한** 쪽이다. 그 방향이 맞다 — 소비자가 받아들일
  // 값을 검증기가 거부해 재시도를 유발하는 일이 없다(반대 방향이면 무한 재시도를 만든다).
  if (typeof value === 'string' && (s.maxLength !== undefined || s.minLength !== undefined)) {
    const len = [...value].length
    if (typeof s.maxLength === 'number' && len > s.maxLength) {
      errors.push(`${path}: too long (${len} > maxLength ${s.maxLength})`)
    }
    if (typeof s.minLength === 'number' && len < s.minLength) {
      errors.push(`${path}: too short (${len} < minLength ${s.minLength})`)
    }
  }

  // number: maximum / minimum — 숫자에만 적용한다(`type:["number","null"]` 의 null 은 제외).
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof s.maximum === 'number' && value > s.maximum) {
      errors.push(`${path}: too large (${value} > maximum ${s.maximum})`)
    }
    if (typeof s.minimum === 'number' && value < s.minimum) {
      errors.push(`${path}: too small (${value} < minimum ${s.minimum})`)
    }
  }

  // array: maxItems / minItems
  if (Array.isArray(value)) {
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      errors.push(`${path}: too many items (${value.length} > maxItems ${s.maxItems})`)
    }
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      errors.push(`${path}: too few items (${value.length} < minItems ${s.minItems})`)
    }
  }

  // object: properties / required / additionalProperties
  if (isPlainObject(value)) {
    const props = isPlainObject(s.properties) ? s.properties : {}
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (!(key in value)) errors.push(`${path}.${key}: required`)
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) {
        errors.push(...collectSchemaErrors(sub, value[key], `${path}.${key}`, root, depth + 1))
      }
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}.${key}: additional property not allowed`)
      }
    }
  }

  // array: items (단일 스키마만 지원)
  if (Array.isArray(value) && s.items && typeof s.items === 'object' && !Array.isArray(s.items)) {
    value.forEach((el, i) => {
      errors.push(...collectSchemaErrors(s.items, el, `${path}[${i}]`, root, depth + 1))
    })
  }

  return errors
}

/**
 * JSON 포인터('#/$defs/Foo' 등)를 root 스키마에서 해석. 해석 실패 시 undefined.
 * @param {any} root
 * @param {string} ref
 */
function resolveRef(root, ref) {
  if (typeof ref !== 'string' || ref[0] !== '#') return undefined
  const frag = ref.slice(1)
  if (frag === '' || frag === '/') return root
  const parts = frag
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
  let node = root
  for (const part of parts) {
    if (node && typeof node === 'object' && part in node) node = node[part]
    else return undefined
  }
  return node
}

/** 값의 쓸모를 좌우하지 않는 키워드 — 아래 `boundsOnly` 판정에서 걷어낸다. */
const BOUNDS_KEYWORDS = ['maxLength', 'minLength', 'maxItems', 'minItems', 'maximum', 'minimum']

/**
 * 스키마에서 경계 키워드만 제거한 사본. 원본을 바꾸지 않는다.
 *
 * 문자열 키를 재귀로 훑는다 — `properties` 안에 `maxLength` 라는 **이름의 프로퍼티**가 있어도
 * 그 자리는 스키마가 아니라 값의 이름이므로 지우면 안 된다. 그래서 `properties`·`$defs`·
 * `definitions` 아래 한 겹은 '이름 → 스키마' 맵으로 취급해 키를 지우지 않고 값만 재귀한다.
 */
function stripBounds(node, inNameMap = false) {
  if (Array.isArray(node)) return node.map((n) => stripBounds(n))
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (!inNameMap && BOUNDS_KEYWORDS.includes(k)) continue
    const isNameMap = !inNameMap && (k === 'properties' || k === '$defs' || k === 'definitions')
    out[k] = stripBounds(v, isNameMap)
  }
  return out
}

/**
 * @returns {{ ok: boolean, errors: string[], boundsOnly: boolean }}
 *
 * `boundsOnly` — 위반이 **경계(길이·개수·범위)뿐**인가. 즉 구조는 맞고 값이 크거나 작을 뿐인가.
 *
 * 이 구분이 필요한 이유: 구조 위반(타입·필수 키·enum·미허용 키)은 데이터를 **쓸 수 없게**
 * 만들지만, 경계 위반은 데이터가 의미상 온전하고 소비자가 자르거나 되돌릴 수 있다. 재시도
 * 캡을 소진했을 때 둘을 같이 버리면 "47자 길다"는 이유로 몇 분짜리 분석 결과 전체가 사라진다.
 * → `turn-manager` 의 캡 소진 분기가 이 값을 보고 데이터를 살린다.
 *
 * 판정은 **경계 키워드를 걷어낸 스키마로 다시 검증**해 얻는다. 오류 문구를 파싱하는 방식은
 * 문구를 고치는 순간 조용히 깨지므로 쓰지 않는다.
 */
export function validateAgainstSchema(schema, value) {
  const errors = collectSchemaErrors(schema, value)
  if (errors.length === 0) return { ok: true, errors, boundsOnly: false }
  const structural = collectSchemaErrors(stripBounds(schema), value)
  return { ok: false, errors, boundsOnly: structural.length === 0 }
}

/**
 * @param {string} type
 * @param {unknown} value
 */
function matchesType(type, value) {
  switch (type) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      // 알 수 없는 type 키워드는 통과로 간주.
      return true
  }
}

/** @param {unknown} value */
function jsonType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** @param {unknown} a @param {unknown} b */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    return ak.length === bk.length && ak.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}
