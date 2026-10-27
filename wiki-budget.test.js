import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WikiBudget, WIKI_READ_BUDGET, WIKI_BUDGET_MESSAGE, isWikiReadTool } from './wiki-budget.js'

describe('isWikiReadTool', () => {
  it('MCP 접두가 붙어도 끝 이름으로 판정한다', () => {
    assert.equal(isWikiReadTool('mcp__daiops-mcp__wiki_search'), true)
    assert.equal(isWikiReadTool('wiki_read'), true)
  })
  it('쓰기 도구와 다른 도구는 세지 않는다', () => {
    assert.equal(isWikiReadTool('mcp__daiops-mcp__wiki_save'), false)
    assert.equal(isWikiReadTool('Bash'), false)
    assert.equal(isWikiReadTool(undefined), false)
  })
})

describe('WikiBudget', () => {
  it(`${WIKI_READ_BUDGET}번째까지 허용하고 그다음 호출부터 막는다`, () => {
    const b = new WikiBudget()
    for (let i = 0; i < WIKI_READ_BUDGET; i++) assert.equal(b.check('mcp__daiops-mcp__wiki_search'), null, `${i + 1}번째`)
    assert.equal(b.check('mcp__daiops-mcp__wiki_read'), WIKI_BUDGET_MESSAGE)
    assert.equal(b.check('mcp__daiops-mcp__wiki_read'), WIKI_BUDGET_MESSAGE)
  })
  it('위키가 아닌 도구는 한도와 상관없이 통과하고 세지 않는다', () => {
    const b = new WikiBudget(1)
    assert.equal(b.check('Bash'), null)
    assert.equal(b.check('wiki_list'), null)
    assert.equal(b.check('Read'), null)
    assert.equal(b.check('wiki_list'), WIKI_BUDGET_MESSAGE)
  })
  it('턴마다 새 인스턴스라 다음 턴은 0부터', () => {
    const first = new WikiBudget(1)
    first.check('wiki_read')
    assert.equal(first.check('wiki_read'), WIKI_BUDGET_MESSAGE)
    assert.equal(new WikiBudget(1).check('wiki_read'), null)
  })
  it('막는 사유는 다시 부르지 말고 지금 답하라고 한다', () => {
    assert.match(WIKI_BUDGET_MESSAGE, /Do not call wiki tools again/)
    assert.match(WIKI_BUDGET_MESSAGE, /Answer now/)
  })
})
