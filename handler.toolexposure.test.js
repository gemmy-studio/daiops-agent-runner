import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { parseToolExposureParam } from './handler.js'
import { buildAnthropicRequest, applyToolExposure } from './turn-manager.js'

// A-1 도구 노출 정책 — cloud가 준 "항상 로드" 목록 외의 MCP 도구를 defer_loading으로 내린다.
//
// 핵심 회귀 둘:
//  (1) 미지정이 undefined로 떨어져야 구버전 cloud(이 필드를 안 보낸다)와 동작이 같다.
//  (2) 지연된 도구가 있으면 tool_search 서버 도구가 **반드시** 함께 실려야 한다.
//      안 실리면 지연된 도구는 모델에게 존재하지 않는 것과 같아진다 — 조용한 능력 상실이고,
//      오류도 경고도 없어서 배선이 빠져도 알아채지 못한다.

describe('parseToolExposureParam', () => {
  it('미지정·비객체는 undefined (구버전 cloud 하위호환)', () => {
    for (const raw of [undefined, null, '', 'x', 3, true, []]) {
      assert.equal(parseToolExposureParam(raw), undefined)
    }
  })

  it('이름 목록이 있으면 통과', () => {
    assert.deepEqual(parseToolExposureParam({ alwaysLoadTools: ['a', 'b'] }), {
      alwaysLoadTools: ['a', 'b'],
    })
  })

  it('빈 목록·비문자열뿐이면 undefined — "정책 없음"으로 확정한다', () => {
    assert.equal(parseToolExposureParam({ alwaysLoadTools: [] }), undefined)
    assert.equal(parseToolExposureParam({ alwaysLoadTools: [1, null, ''] }), undefined)
    assert.equal(parseToolExposureParam({ alwaysLoadTools: 'a,b' }), undefined)
  })

  it('문자열이 아닌 항목만 걸러낸다', () => {
    assert.deepEqual(parseToolExposureParam({ alwaysLoadTools: ['a', 2, null, 'b'] }), {
      alwaysLoadTools: ['a', 'b'],
    })
  })
})

describe('applyToolExposure', () => {
  const tools = () => [
    { name: 'Read', input_schema: {} },
    { name: 'Bash', input_schema: {} },
    { name: 'mcp__lattice-mcp__search_companies', input_schema: {} },
    { name: 'mcp__lattice-mcp__get_bluecard', input_schema: {} },
    { name: 'mcp__daiops-mcp__skill_view', input_schema: {} },
    { name: 'mcp__daiops-mcp__skill_manage', input_schema: {} },
  ]

  it('정책이 없으면 아무것도 바꾸지 않는다 (현행 동작)', () => {
    for (const exposure of [undefined, null, {}, { alwaysLoadTools: 'x' }]) {
      const out = applyToolExposure(tools(), exposure)
      assert.equal(out.deferred, 0)
      assert.equal(out.tools.some((t) => t.defer_loading), false)
    }
  })

  it('목록에 없는 MCP 도구만 내린다 — 맨 이름으로 맞춘다', () => {
    const out = applyToolExposure(tools(), {
      alwaysLoadTools: ['search_companies', 'skill_view'],
    })
    const by = Object.fromEntries(out.tools.map((t) => [t.name, !!t.defer_loading]))
    assert.equal(by['mcp__lattice-mcp__search_companies'], false)
    assert.equal(by['mcp__daiops-mcp__skill_view'], false)
    assert.equal(by['mcp__lattice-mcp__get_bluecard'], true)
    assert.equal(by['mcp__daiops-mcp__skill_manage'], true)
    assert.equal(out.deferred, 2)
  })

  it('빌트인은 목록에 없어도 절대 내리지 않는다', () => {
    const out = applyToolExposure(tools(), { alwaysLoadTools: ['search_companies'] })
    const by = Object.fromEntries(out.tools.map((t) => [t.name, !!t.defer_loading]))
    assert.equal(by.Read, false)
    assert.equal(by.Bash, false)
  })

  it('원본 배열·객체를 변형하지 않는다', () => {
    const input = tools()
    applyToolExposure(input, { alwaysLoadTools: ['search_companies'] })
    assert.equal(input.some((t) => 'defer_loading' in t), false)
  })

  it('전부 지연이 되면 표시를 걷어낸다 — Anthropic 400 방지', () => {
    // MCP 도구만 있고 목록이 하나도 안 맞는 경우.
    const onlyMcp = [
      { name: 'mcp__x__a', input_schema: {} },
      { name: 'mcp__x__b', input_schema: {} },
    ]
    const out = applyToolExposure(onlyMcp, { alwaysLoadTools: ['없는이름'] })
    assert.equal(out.deferred, 0)
    assert.equal(out.tools.some((t) => t.defer_loading), false)
  })

  it('접두어가 붙은 정식 이름으로 줘도 맞는다', () => {
    const out = applyToolExposure(tools(), {
      alwaysLoadTools: ['mcp__lattice-mcp__get_bluecard'],
    })
    const by = Object.fromEntries(out.tools.map((t) => [t.name, !!t.defer_loading]))
    assert.equal(by['mcp__lattice-mcp__get_bluecard'], false)
  })
})

describe('buildAnthropicRequest — 지연 도구가 있으면 검색 도구를 함께 싣는다', () => {
  const base = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }

  it('지연 도구가 없으면 검색 도구를 싣지 않는다', () => {
    const body = buildAnthropicRequest({
      ...base,
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    })
    assert.equal(body.tools.some((t) => t.type?.startsWith('tool_search')), false)
  })

  it('지연 도구가 하나라도 있으면 tool_search_tool_regex를 싣는다', () => {
    const body = buildAnthropicRequest({
      ...base,
      tools: [
        { name: 'Read', input_schema: { type: 'object' } },
        { name: 'mcp__lattice__get_bluecard', input_schema: { type: 'object' }, defer_loading: true },
      ],
    })
    const search = body.tools.find((t) => t.type === 'tool_search_tool_regex_20251119')
    assert.ok(search, '검색 도구가 실려야 한다')
    // ⚠️ name은 임의로 정할 수 없다 — 다른 값이면 Anthropic이 400을 준다.
    assert.equal(search.name, 'tool_search_tool_regex')
  })
})

// ── 배선 정적 검증 ─────────────────────────────────────────────────────────
// 정책이 어느 한 홉에서 끊기면 러너는 전량 로드로 돈다. 그건 **현행 동작과 똑같아서**
// 오류도 경고도 없다. 그래서 홉마다 고정한다.
describe('정책이 handler → llm-wrapper → turn-manager 로 실제로 흐르는가', () => {
  const handler = fs.readFileSync(new URL('./handler.js', import.meta.url), 'utf-8')
  const wrapper = fs.readFileSync(new URL('./llm-wrapper.js', import.meta.url), 'utf-8')
  const turnManager = fs.readFileSync(new URL('./turn-manager.js', import.meta.url), 'utf-8')

  it('handler가 요청에서 파싱해 queryOptions에 싣는다', () => {
    assert.match(handler, /tool_exposure:\s*parseToolExposureParam\(rawParams\.tool_exposure\)/)
    assert.match(handler, /toolExposure:\s*params\.tool_exposure/)
  })

  it('llm-wrapper가 turn-manager로 forward한다', () => {
    assert.match(wrapper, /toolExposure:\s*opts\.toolExposure/)
  })

  it('turn-manager가 머지 직후 적용한다', () => {
    assert.match(turnManager, /applyToolExposure\(merged,\s*input\.options\.toolExposure\)/)
  })

  it('검색 결과 블록을 보존 목록에 넣는다 — 안 넣으면 다음 턴 요청이 400 난다', () => {
    assert.match(turnManager, /'tool_search_tool_result'/)
  })
})
