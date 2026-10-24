/**
 * 외부 MCP 도구 정의 정화 · 지문 (외부 MCP 신뢰 경계, 0.32.0).
 *
 * 도구 설명은 모델이 그대로 읽는 글이라, 등록한 서버가 설명에 지시를 숨겨 넣으면 직원이 그 지시를 따른다.
 * 여기서는 (1) 글을 숨기는 문자(제어 · 폭 0 · 방향 덮어쓰기 · 태그 문자)를 지우고 설명 길이를 자르며
 * (2) 이름이 규칙 밖이거나 스키마가 너무 큰 도구를 빼고 (3) 도구마다 지문(sha256)을 만든다.
 *
 * ⚠️ 클라우드 `src/lib/security/mcp-tool-text.ts` 와 **같은 결과**를 내야 한다. 클라우드가 승인 때 만든 지문과
 * 러너가 턴마다 만든 지문을 대조하므로, 갈리면 모든 서버가 「바뀜」으로 막힌다. 두 레포가 같은 시험 자료
 * (`test-fixtures/mcp-tool-fingerprint-vectors.json`)를 읽는다. 계약은 `CONTRACT.md` 「외부 MCP 도구 지문」.
 *
 * 인젝션 문구 경고는 여기 없다. 사람이 승인할 때 보는 것이라 클라우드 연결 테스트 · 승인이 한다.
 */

import { createHash } from 'node:crypto'

/** 설명 길이 상한. openclaude `MAX_MCP_DESCRIPTION_LENGTH` 와 같은 값 */
export const MAX_TOOL_DESCRIPTION_CHARS = 2048
/** 정화한 스키마를 JSON 으로 적었을 때 상한. 넘으면 그 도구를 뺀다 */
export const MAX_TOOL_SCHEMA_CHARS = 16_384
/** 원래 도구 이름 규칙. 모델 API 도구 이름 문자셋이고, 접두사를 붙여도 넘치지 않게 64자 */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
/** MCP 표준 `ToolAnnotations` 의 불리언 힌트. `mcp-client.js` `ANNOTATION_BOOL_KEYS` 와 같다 */
const HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']

/** C0 제어(탭 · 줄바꿈 · 복귀 제외) · DEL · 폭 0 · 줄/문단 구분자 · 방향 덮어쓰기 · 방향 격리 · BOM · 태그 문자 */
const HIDDEN_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu

/** @param {string} text */
export function sanitizeMcpToolText(text) {
  return text.replace(HIDDEN_CHARS_RE, '')
}

/** @param {string} text */
function capDescription(text) {
  return text.length <= MAX_TOOL_DESCRIPTION_CHARS ? text : `${text.slice(0, MAX_TOOL_DESCRIPTION_CHARS)}… [truncated]`
}

/** 스키마 안 `description` · `title` 만 정화한다. 속성 이름 · enum 값은 인자 계약이라 건드리지 않는다 */
function sanitizeSchemaNode(node) {
  if (Array.isArray(node)) return node.map(sanitizeSchemaNode)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    out[k] = (k === 'description' || k === 'title') && typeof v === 'string' ? sanitizeMcpToolText(v) : sanitizeSchemaNode(v)
  }
  return out
}

/** 불리언인 힌트만 고른다. 하나도 없으면 undefined. 지문에 넣어 승인 뒤 「읽기 전용」으로 바꿔 결재를 건너뛰는 길을 막는다 */
function pickHints(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const k of HINT_KEYS) if (typeof raw[k] === 'boolean') out[k] = raw[k]
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * `tools/list` 모든 쪽을 합친 배열을 정화한다. 이름이 없는 항목은 버리고, 같은 이름은 앞의 것만 쓴다.
 * @param {unknown[]} raw
 * @returns {{ tools: Array<{ name: string, description?: string, inputSchema: object, annotations?: object }>, dropped: Array<{ name: string, reason: 'invalid_name' | 'schema_too_large' }> }}
 */
export function normalizeMcpTools(raw) {
  const tools = []
  const dropped = []
  const seen = new Set()
  for (const item of raw) {
    const t = item ?? {}
    const name = String(t.name ?? '')
    if (!name || seen.has(name)) continue
    seen.add(name)
    if (!TOOL_NAME_RE.test(name)) {
      dropped.push({ name: name.slice(0, 64), reason: 'invalid_name' })
      continue
    }
    const schema = t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
      ? sanitizeSchemaNode(t.inputSchema)
      : { type: 'object' }
    if (JSON.stringify(schema).length > MAX_TOOL_SCHEMA_CHARS) {
      dropped.push({ name, reason: 'schema_too_large' })
      continue
    }
    const description = typeof t.description === 'string' ? capDescription(sanitizeMcpToolText(t.description)) : ''
    const hints = pickHints(t.annotations)
    tools.push({ name, ...(description ? { description } : {}), inputSchema: schema, ...(hints ? { annotations: hints } : {}) })
  }
  return { tools, dropped }
}

/** 키를 정렬한 JSON. 같은 스키마를 키 순서만 바꿔 보내도 지문이 같아야 한다 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** @param {{ name: string, description?: string, inputSchema: object }} tool */
export function fingerprintMcpTool(tool) {
  return createHash('sha256')
    .update(canonicalJson({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, annotations: tool.annotations ?? {} }))
    .digest('hex')
}

/** @param {Array<{ name: string, description?: string, inputSchema: object }>} tools */
export function fingerprintMcpTools(tools) {
  return Object.fromEntries(tools.map((t) => [t.name, fingerprintMcpTool(t)]))
}

/**
 * 승인 때 지문과 지금 지문의 차이. 도구가 늘거나 바뀌면 막는다. 빠지기만 하면 막지 않는다(새로 할 수 있는 일이 없다).
 * @param {Record<string, string>} pinned
 * @param {Record<string, string>} observed
 */
export function diffMcpToolFingerprints(pinned, observed) {
  const added = Object.keys(observed).filter((n) => !(n in pinned))
  const changed = Object.keys(observed).filter((n) => n in pinned && pinned[n] !== observed[n])
  const removed = Object.keys(pinned).filter((n) => !(n in observed))
  return { added, changed, removed, blocked: added.length + changed.length > 0 }
}
