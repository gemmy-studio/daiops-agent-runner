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
 *  - anyOf (하나라도 통과하면 OK)
 * 미지원 키워드(minLength/maximum/pattern 등)는 무시 — 통과로 간주.
 */

/**
 * @param {unknown} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]} 위반 메시지 목록 (빈 배열이면 통과)
 */
export function collectSchemaErrors(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') return []
  /** @type {Record<string, any>} */
  const s = schema

  // anyOf — 하나라도 통과하면 OK.
  if (Array.isArray(s.anyOf)) {
    const anyOk = s.anyOf.some((sub) => collectSchemaErrors(sub, value, path).length === 0)
    if (!anyOk) return [`${path}: does not match any of the allowed schemas`]
    return []
  }

  /** @type {string[]} */
  const errors = []

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
        errors.push(...collectSchemaErrors(sub, value[key], `${path}.${key}`))
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
      errors.push(...collectSchemaErrors(s.items, el, `${path}[${i}]`))
    })
  }

  return errors
}

/** @returns {{ ok: boolean, errors: string[] }} */
export function validateAgainstSchema(schema, value) {
  const errors = collectSchemaErrors(schema, value)
  return { ok: errors.length === 0, errors }
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
