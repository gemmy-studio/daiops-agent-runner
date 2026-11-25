// @ts-check
/**
 * 늦게 싣는 도구의 목차(T1-5, 2026-10-27 대표 「사무실판, 클라우드 모두 통일 … 공통 기능은 하나로」).
 *
 * 미룬 도구는 설명서가 모델에게 가지 않는다. 목차가 없으면 모델은 무엇을 찾을지 모른다(10/25 사무실 1차: 목차 없이
 * 찾게 하자 51번 중 2번만 찾았다). 그래서 시스템 끝에 묶음 → 도구 이름 · 한 줄 → 규칙 줄을 늘 붙인다.
 * Claude Code 도 「Only tool names and server instructions load at session start」(code.claude.com/docs/en/mcp),
 * Anthropic 은 「Add a system prompt section describing available tool categories」(tool search 문서).
 *
 * 왜 러너인가: 클라우드(러너 → Anthropic)와 사무실(러너 → 앱 프록시 → vLLM) 두 판이 모두 지나고, 바깥 MCP 서버의
 * 실제 설명서를 보는 곳이 여기뿐이다. 클라우드 앱은 바깥 도구의 지문만 안다. 종전에는 사무실 프록시에만 있어
 * 클라우드 모델은 미룬 도구가 있다는 것도 몰랐다.
 *
 * 찾기를 실행하는 쪽(Anthropic 서버 도구 / 사무실 프록시 흉내)은 판마다 다르다. 그래서 안내는 찾기 도구 이름을
 * 부르지 않고 「도구 이름을 그대로 넣는다」로 쓴다. 정규식 찾기에도, 프록시의 이름 일치 찾기에도 맞는다.
 */

/**
 * 미룰 MCP 도구가 이보다 적으면 미루지 않는다. Anthropic: 「Standard tool calling … is a better fit when you have
 * fewer than 10 tools」.
 */
export const MIN_DEFERRED_TOOLS = 10

/**
 * 2층(도구 이름 + 한 줄)을 늘 보여 주는 상한(글자). 넘으면 1층(묶음 이름 · 개수)만 싣는다(대표 10/25 「도구가
 * 수백개 이상이 넘어가면 위키와 같이 계층」). 값은 11/8 판 측정으로 정한다.
 */
export const TOOL_INDEX_MAX_CHARS = 12_000
const SUMMARY_MAX_CHARS = 100

/** 목차 머리 안내 세 줄(대표 10/25 「위 권장대로 하자」). */
export const TOOL_INDEX_GUIDE = [
  '- 없다 · 못 한다고 답하기 전에 먼저 도구를 찾으십시오.',
  '- 스킬을 새로 만들거나 바깥을 조사하기 전에 가진 도구 · 스킬부터 보십시오.',
  '- 목록에 이름만 있는 도구는 찾아서 연 뒤 부르십시오.',
].join('\n')

/**
 * 「규칙」을 어떻게 쓰는지. 결재가 걸린 일은 글로 되묻지 말고 도구를 부른다(부르면 결재 카드가 뜬다).
 * 10/26 사무실 2차: 「부르지 않을 때도 그 규칙대로 안내」를 읽고 위키 삭제를 글로 되물어 3번 중 2번 실패했다.
 */
export const TOOL_INDEX_RULE_NOTE =
  '「규칙」은 사람이 물을 때 답하는 근거입니다. 결재 · 승인이 필요한 일을 하라고 하면 글로 되묻지 말고 그 도구를 ' +
  '찾아 부르십시오. 부르면 결재 카드가 뜹니다.'

/** `mcp__서버__도구` 의 서버 이름. MCP 가 아니면 null. */
function serverOf(name) {
  const m = /^mcp__(.+?)__/.exec(name)
  return m ? m[1] : null
}

/** @param {string} text */
function firstSentence(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat
  return sentence.length > SUMMARY_MAX_CHARS ? `${sentence.slice(0, SUMMARY_MAX_CHARS - 1)}…` : sentence
}

/**
 * 설명서의 필수 칸 이름. 없거나 꼴이 틀리면 빈 배열.
 *
 * @param {{ input_schema?: any }} tool
 * @returns {string[]}
 */
function requiredArgNames(tool) {
  const schema = tool.input_schema
  const required = schema && typeof schema === 'object' ? schema.required : undefined
  return Array.isArray(required) ? required.filter((k) => typeof k === 'string' && k.length > 0) : []
}

/**
 * 목차 한 줄: 부를 때 쓰는 이름, 필수 칸 이름, 설명서 첫 문장. `rules` 에 그 도구의 규칙이 있으면 덧붙인다.
 * 규칙은 클라우드가 자기 도구에 대해서만 보낸다(정식 이름 키). 바깥 서버는 스스로 규칙을 정할 수 없다.
 *
 * 필수 칸 이름(T5-2, 11/21 대표 「권장안대로」): 사무실판 Gemma 는 목차의 「찾아서 연 뒤 부르십시오」를 따르지 않고
 * 찾기 없이 바로 부른다(11/18 3번 부스 19회 모두 찾기 0). 칸 이름을 짐작해 결재 전 검사에 6회 돌려보내졌다
 * (calendar_create 를 description 만으로, mail_send 를 to 없이). 설명서 전체 대신 필수 칸 이름만 둔다.
 * Anthropic 목차는 이름만 두지만, 찾기를 건너뛰는 모델을 받아야 해서 다르게 간다
 *
 * @param {{ name: string, description?: string, input_schema?: any }} tool
 * @param {Readonly<Record<string, string>>} [rules]
 * @param {{ args?: boolean }} [opts] args=false 면 칸 이름을 뺀다(목차가 상한을 넘을 때)
 */
export function toolIndexLine(tool, rules = {}, { args = true } = {}) {
  const summary = firstSentence(tool.description ?? '')
  const rule = Object.hasOwn(rules, tool.name) ? rules[tool.name] : undefined
  const tail = rule && !summary.includes(rule) ? ` 규칙: ${rule}` : ''
  const required = args ? requiredArgNames(tool) : []
  const sig = required.length > 0 ? `(${required.join(', ')})` : ''
  return `- ${tool.name}${sig}: ${summary}${tail}`
}

/**
 * 시스템 끝에 붙이는 목차. 1층 = 묶음(MCP 서버) 이름 · 개수, 2층 = 도구 이름 + 필수 칸 + 한 줄. 2층이 상한을 넘으면
 * 필수 칸을 빼고, 그래도 넘으면 1층만.
 * 대화 안에서 글이 바뀌면 캐시 앞부분이 깨지므로, 미룬 도구 **전부**(이미 찾은 것 포함)로 이름순으로 만든다.
 *
 * @param {Array<{ name: string, description?: string, input_schema?: any }>} deferred
 * @param {Readonly<Record<string, string>>} [rules]
 * @param {Readonly<Record<string, string>>} [notes] 묶음(서버) 이름 → 하는 일 한 줄
 */
export function toolIndexText(deferred, rules = {}, notes = {}) {
  /** @type {Map<string, Array<{ name: string, description?: string, input_schema?: any }>>} */
  const groups = new Map()
  for (const t of [...deferred].sort((a, b) => a.name.localeCompare(b.name))) {
    const g = serverOf(t.name) ?? '기타'
    groups.set(g, [...(groups.get(g) ?? []), t])
  }
  const order = [...groups.keys()].sort()
  // 묶음 이름 옆에 그 묶음이 하는 일(서버 안내문 첫 문장, tool-guidance.js `serverNote`). 레퍼런스가 모두 권하는
  // 「범주 · 묶음 단위 안내」다(Anthropic 「describing available tool categories」, MCP `instructions`)
  const head = (g) => `[${g}] ${groups.get(g)?.length}개${Object.hasOwn(notes, g) ? ` — ${notes[g]}` : ''}`
  const render = (args) =>
    order.map((g) => `${head(g)}\n${(groups.get(g) ?? []).map((t) => toolIndexLine(t, rules, { args })).join('\n')}`).join('\n')
  // 칸 이름을 붙여 넘치면 칸 이름부터 뺀다. 도구 이름 줄(2층)이 묶음만 남기는 1층보다 낫다
  let full = render(true)
  if (full.length > TOOL_INDEX_MAX_CHARS) full = render(false)
  if (full.length <= TOOL_INDEX_MAX_CHARS) {
    return (
      `${TOOL_INDEX_GUIDE}\n아래 도구는 설명서를 빼 두었습니다. 쓰려면 먼저 도구 찾기에 그 도구 이름을 그대로 넣어 ` +
      `불러온 뒤 부르십시오. ${TOOL_INDEX_RULE_NOTE}\n${full}`
    )
  }
  const groupsLine = order.map((g) => `- ${head(g).slice(1).replace('] ', ': ')}`).join('\n')
  return (
    `${TOOL_INDEX_GUIDE}\n도구 묶음 목록입니다(도구가 많아 설명서와 이름을 빼 두었습니다). 쓰려면 도구 찾기에 ` +
    `묶음 이름과 하려는 일을 낱말로 넣어 찾은 뒤 부르십시오.\n${groupsLine}`
  )
}

/**
 * 시스템 지시문 끝에 목차를 붙인다. 블록 배열이면 새 블록으로 덧붙여 캐시 표시가 그 뒤(마지막 블록)에 붙게 한다.
 *
 * @param {string | Array<any> | undefined} system
 * @param {string} text
 */
export function appendToolIndex(system, text) {
  if (typeof system === 'string') return system ? `${system}\n\n${text}` : text
  if (Array.isArray(system)) return [...system, { type: 'text', text }]
  return text
}
