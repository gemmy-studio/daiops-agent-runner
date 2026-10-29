// @ts-check
/**
 * 미룬 도구를 모델이 찾아 쓰게 돕는 셋(T1-5, 2026-10-29). 셋 다 레퍼런스 권고를 따른다.
 *
 * 1. 묶음 안내 — MCP 서버가 initialize 때 보내는 `instructions` 의 첫 문장을 목차의 묶음 이름 옆에 붙인다.
 *    MCP 규격: 「Instructions describing how to use the server and its features … like a "hint" to the model」.
 *    Anthropic tool search: 「Add a system prompt section describing available tool categories」.
 *    Claude Code: 「Server instructions help Claude understand when to search for your tools」.
 * 2. 없는 도구 안내 — 등록되지 않은 이름을 부르면 같은 서버의 가까운 이름을 함께 돌려준다.
 *    Anthropic(Writing tools for agents): 「prompt-engineer your error responses to clearly communicate specific and
 *    actionable improvements」. Claude Code 는 찾기 결과가 비면 이유를 함께 준다.
 *    실측: 10/29 블루 대시보드에서 없는 도구(list_peer_candidates)를 부르고 「not found」만 받자, 도구를 줄인 상태에서는
 *    지시문이 적은 대체 도구를 찾지 않고 비교 단계를 건너뛰었다.
 * 3. 쓰는 예시 — 우리 서버가 도구 `_meta["anthropic/inputExamples"]` 로 준 예시를 Anthropic 도구 정의의
 *    `input_examples` 로 옮긴다(정식 기능, 베타 헤더 없음). Anthropic: 정확도 72% → 90%(advanced tool use).
 *    `_meta["anthropic/..."]` 는 Claude Code 가 `alwaysLoad` 를 싣는 자리와 같은 이름 꼴이다.
 *    ⚠️ 예시 하나라도 `input_schema` 에 맞지 않으면 요청 전체가 400 이다(Anthropic define-tools 문서). 그래서 여기서
 *    한 번 더 거르고, 하나라도 어긋나면 그 도구의 예시를 통째로 버린다(턴을 죽이지 않는 쪽).
 */

/**
 * 예시를 받아 주는 서버. 바깥 서버(고객이 등록한 MCP)의 예시는 프롬프트에 그대로 실리므로 받지 않는다.
 * 이름은 클라우드 `qualified-tool-name.ts` 의 서버 이름과 같아야 한다.
 */
export const TRUSTED_EXAMPLE_SERVERS = new Set(['daiops-mcp', 'daiops-wiki-local'])

/** 도구 하나에 붙이는 예시 상한. Anthropic 권고 「1-5 examples per tool」, 입력이 늘지 않게 셋 */
export const MAX_INPUT_EXAMPLES = 3

/** 묶음 안내 한 줄 상한(글자) */
export const SERVER_NOTE_MAX_CHARS = 160

const TYPE_CHECK = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
}

/**
 * 예시 하나가 스키마에 맞는가(위 수준만: 필수 값 · 모르는 키 · 값 종류 · 허용값). 중첩 검사는 하지 않는다.
 * @param {unknown} example
 * @param {any} schema
 */
export function exampleFitsSchema(example, schema) {
  if (!TYPE_CHECK.object(example)) return false
  const ex = /** @type {Record<string, unknown>} */ (example)
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {}
  for (const key of Array.isArray(schema?.required) ? schema.required : []) {
    if (ex[key] === undefined) return false
  }
  for (const [key, value] of Object.entries(ex)) {
    const prop = props[key]
    if (!prop) {
      // 스키마가 받지 않는 키. additionalProperties 가 명시적으로 열려 있을 때만 통과
      if (schema?.additionalProperties === true) continue
      return false
    }
    const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : []
    if (types.length > 0 && !types.some((t) => TYPE_CHECK[t]?.(value) ?? true)) return false
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return false
  }
  return true
}

/**
 * 믿는 서버가 준 예시만, 스키마에 모두 맞을 때만 돌려준다. 아니면 undefined(예시 없이 싣는다).
 * @param {string} serverName
 * @param {unknown} meta 도구의 `_meta`
 * @param {any} schema
 */
export function pickInputExamples(serverName, meta, schema) {
  if (!TRUSTED_EXAMPLE_SERVERS.has(serverName)) return undefined
  const raw = meta && typeof meta === 'object' ? /** @type {any} */ (meta)['anthropic/inputExamples'] : undefined
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const examples = raw.slice(0, MAX_INPUT_EXAMPLES)
  return examples.every((e) => exampleFitsSchema(e, schema)) ? examples : undefined
}

/**
 * 서버 안내문을 목차 한 줄로. 첫 문장, 상한 글자. 비거나 문자열이 아니면 undefined.
 * @param {unknown} instructions
 */
export function serverNote(instructions) {
  if (typeof instructions !== 'string') return undefined
  const flat = instructions.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  const sentence = /^(.+?[.!?。])(\s|$)/.exec(flat)?.[1] ?? flat
  return sentence.length > SERVER_NOTE_MAX_CHARS ? `${sentence.slice(0, SERVER_NOTE_MAX_CHARS - 1)}…` : sentence
}

/** `mcp__서버__도구` → [서버, 도구]. MCP 이름이 아니면 null */
function splitMcpName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? [m[1], m[2]] : null
}

/**
 * 없는 도구 이름과 가까운 등록 도구(같은 서버 우선, 이름 낱말이 겹치는 순). 최대 limit 개.
 * @param {string} name
 * @param {Iterable<string>} registered
 * @param {number} [limit]
 */
export function similarToolNames(name, registered, limit = 5) {
  const target = splitMcpName(name)
  // 첫 낱말은 동작(list · get · search …), 나머지는 대상. 대상이 겹치면 더 가깝다. 동작만 같아도 같은 서버면 후보로
  // 둔다: 10/29 의 list_peer_candidates 는 대상이 겹치는 도구가 없고, 지시문이 적은 대체는 같은 동작의 list_portfolio 였다
  const [verb, ...nouns] = (target?.[1] ?? name).toLowerCase().split(/[_\-]+/).filter((w) => w.length > 1)
  const nounSet = new Set(nouns)
  const scored = []
  for (const candidate of registered) {
    const parts = splitMcpName(candidate)
    if (!parts || candidate === name) continue
    const sameServer = target ? parts[0] === target[0] : false
    const [cVerb, ...cNouns] = parts[1].toLowerCase().split(/[_\-]+/).filter((w) => w.length > 1)
    const nounOverlap = cNouns.filter((w) => nounSet.has(w)).length
    const score = nounOverlap * 2 + (verb && cVerb === verb ? 1 : 0) + (sameServer ? 1 : 0)
    scored.push({ candidate, score })
  }
  return scored
    .filter((s) => s.score > 1)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((s) => s.candidate)
}

/**
 * 없는 도구를 불렀을 때 모델에게 돌려줄 오류 문장. 대체 도구를 고르고, 미뤄 둔 도구면 찾아서 열게 한다.
 * @param {string} name
 * @param {string[]} candidates
 */
export function unknownToolMessage(name, candidates) {
  const head = `mcp-client: tool '${name}' not found in registry. 이 이름의 도구는 없습니다.`
  if (candidates.length === 0) {
    return `${head} 목차에서 하려는 일에 맞는 도구를 찾아 연 뒤 부르십시오. 정말 없을 때만 그 단계를 건너뛰고 이유를 결과에 적으십시오.`
  }
  return (
    `${head} 비슷한 도구: ${candidates.join(', ')}. 지시문이 대체 도구를 적어 두었다면 그것을 쓰십시오. ` +
    '목차에 이름만 있는 도구는 도구 찾기에 그 이름을 넣어 연 뒤 부르십시오.'
  )
}
