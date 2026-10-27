/**
 * 위키 탐색 한도 (T3-9, 2026-10-27).
 *
 * 직원은 위키 검색 · 읽기 도구를 몇 번 부를지 지시문으로만 정해 왔다. 턴 한도(기본 50, 자동 연장 최대 140)에
 * 닿으면 답 없이 끊기므로, 탐색이 길어진 질문은 아무것도 돌려받지 못한다. 그래서 한 턴의 위키 읽기 호출을
 * 세다가 한도를 넘는 호출은 막고, 막는 사유로 「지금까지 읽은 것으로 답하라」를 돌려준다. 턴은 끊지 않는다.
 *
 * 레퍼런스: open_deep_research 는 연구자 도구 호출을 코드로 10회 묶고, 닿으면 오류 없이 정리 단계로 넘긴다
 * (max_react_tool_calls). OpenDeepWiki 는 쪽마다 탐색 6회(DocumentSourceToolBudget.cs). Claude Agent SDK 의
 * maxTurns 는 닿으면 결과 없이 끝난다(error_max_turns). 아카이브 261027-plan-t3-reading-wiki-src/research/r3-tool-budget.md.
 *
 * 한도 15 는 우리가 정했다: 10/26 위키 골든셋 1,257회 실행에서 문항당 위키 도구 호출이 p99 11 · 최대 20 이었다.
 * 보통 답은 건드리지 않고 긴 꼬리만 자른다. 쓰기 도구(wiki_save 등)는 세지 않는다. 탐색이 아니다.
 */

/** 한 턴에 허용하는 위키 읽기 호출 수. 이보다 많은 호출은 막는다 */
export const WIKI_READ_BUDGET = 15

const WIKI_READ_TOOLS = new Set(['wiki_search', 'wiki_read', 'wiki_list', 'wiki_fact_lookup', 'wiki_fact_aggregate'])

/** MCP 도구는 `mcp__<서버>__<도구>` 로 온다. 끝 이름으로 판정한다 */
export function isWikiReadTool(toolName) {
  const bare = String(toolName ?? '').replace(/^mcp__.+?__/, '')
  return WIKI_READ_TOOLS.has(bare)
}

export const WIKI_BUDGET_MESSAGE =
  `Wiki lookup limit reached (${WIKI_READ_BUDGET} wiki calls this turn). Do not call wiki tools again in this turn. ` +
  'Answer now using only what you have already read, and say plainly which parts you could not find.'

export class WikiBudget {
  constructor(budget = WIKI_READ_BUDGET) {
    this.budget = budget
    this.used = 0
  }

  /**
   * 호출 직전에 부른다. 위키 읽기 도구가 아니면 null, 한도 안이면 세고 null, 넘으면 막는 사유.
   * 막힌 호출은 세지 않는다(실행되지 않았다).
   * @param {string} toolName
   * @returns {string | null}
   */
  check(toolName) {
    if (!isWikiReadTool(toolName)) return null
    if (this.used >= this.budget) return WIKI_BUDGET_MESSAGE
    this.used++
    return null
  }
}
