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
 * 미지원 키워드(minLength/maximum/pattern 등)는 무시 — 통과로 간주.
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
