import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_INPUT_EXAMPLES,
  exampleFitsSchema,
  pickInputExamples,
  serverNote,
  similarToolNames,
  unknownToolMessage,
} from './tool-guidance.js'
import { toolIndexText } from './tool-index.js'
import { createMcpToolRegistry } from './mcp-client.js'

const WIKI_READ = {
  type: 'object',
  properties: { page_name: { type: 'string' }, category: { type: 'string' }, offset: { type: 'number' } },
  required: ['page_name'],
}

describe('쓰는 예시(input_examples)', () => {
  it('스키마에 맞는 예시만 통과한다 — 하나라도 어긋나면 요청 전체가 400 이라', () => {
    assert.equal(exampleFitsSchema({ page_name: 'a.md' }, WIKI_READ), true)
    assert.equal(exampleFitsSchema({ name: 'a.md' }, WIKI_READ), false) // 필수 빠짐 + 모르는 키
    assert.equal(exampleFitsSchema({ page_name: 'a.md', offset: '3' }, WIKI_READ), false) // 값 종류
    assert.equal(exampleFitsSchema({ page_name: 'a.md', extra: 1 }, WIKI_READ), false) // 모르는 키
    assert.equal(exampleFitsSchema({ op: 'max' }, { properties: { op: { type: 'string', enum: ['min'] } } }), false)
  })

  it('믿는 서버의 예시만 · 전부 맞을 때만 · 상한까지만 싣는다', () => {
    const meta = { 'anthropic/inputExamples': [{ page_name: 'a.md' }, { page_name: 'b.md', category: 'c' }] }
    assert.deepEqual(pickInputExamples('daiops-mcp', meta, WIKI_READ), meta['anthropic/inputExamples'])
    assert.equal(pickInputExamples('lattice-mcp', meta, WIKI_READ), undefined) // 바깥 서버는 받지 않는다
    const bad = { 'anthropic/inputExamples': [{ page_name: 'a.md' }, { name: 'b' }] }
    assert.equal(pickInputExamples('daiops-mcp', bad, WIKI_READ), undefined) // 하나라도 틀리면 통째로 버림
    const many = { 'anthropic/inputExamples': Array.from({ length: 6 }, (_, i) => ({ page_name: `${i}.md` })) }
    assert.equal(pickInputExamples('daiops-mcp', many, WIKI_READ)?.length, MAX_INPUT_EXAMPLES)
  })
})

describe('묶음 안내', () => {
  it('서버 안내문 첫 문장을 묶음 이름 옆에 붙인다', () => {
    assert.equal(serverNote('Lattice 투자 데이터 조회. 회사 · 포트폴리오를 봅니다.'), 'Lattice 투자 데이터 조회.')
    assert.equal(serverNote(''), undefined)
    const deferred = [{ name: 'mcp__lattice-mcp__list_portfolio', description: '포트폴리오 목록.' }]
    const text = toolIndexText(deferred, {}, { 'lattice-mcp': 'Lattice 투자 데이터 조회.' })
    assert.match(text, /\[lattice-mcp\] 1개 — Lattice 투자 데이터 조회\./)
  })
})

describe('없는 도구 안내', () => {
  const registered = [
    'mcp__lattice-mcp__list_portfolio',
    'mcp__lattice-mcp__list_valuations',
    'mcp__lattice-mcp__get_company',
    'mcp__daiops-mcp__wiki_list',
  ]

  it('10/29 실측: 없는 list_peer_candidates 에 같은 서버의 list_* 를 후보로 준다', () => {
    const c = similarToolNames('mcp__lattice-mcp__list_peer_candidates', registered)
    assert.ok(c.includes('mcp__lattice-mcp__list_portfolio'))
    assert.ok(!c.includes('mcp__daiops-mcp__wiki_list')) // 다른 서버 · 겹치는 낱말 없음
  })

  it('오류 문장은 종전 첫머리를 지키고 다음 행동을 알린다', () => {
    const msg = unknownToolMessage('mcp__lattice-mcp__list_peer_candidates', ['mcp__lattice-mcp__list_portfolio'])
    assert.match(msg, /not found in registry/)
    assert.match(msg, /비슷한 도구: mcp__lattice-mcp__list_portfolio/)
    assert.match(unknownToolMessage('mcp__x__y', []), /정말 없을 때만/)
  })

  it('등록부 runTool 이 이 문장으로 던진다', async () => {
    const reg = await createMcpToolRegistry([])
    await assert.rejects(reg.runTool('mcp__lattice-mcp__list_peer_candidates', {}), /이 이름의 도구는 없습니다/)
  })
})
