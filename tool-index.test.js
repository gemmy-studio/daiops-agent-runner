import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TOOL_INDEX_GUIDE,
  TOOL_INDEX_MAX_CHARS,
  TOOL_INDEX_RULE_NOTE,
  appendToolIndex,
  toolIndexLine,
  toolIndexText,
} from './tool-index.js'
import { withToolIndex } from './turn-manager.js'
import { parseToolExposureParam } from './handler.js'

// T1-5(10/27): 미룬 도구 목차는 두 판(클라우드 · 사무실)이 같은 글을 받도록 러너 한 곳에서 만든다.
// 종전에는 사무실 프록시(local-tool-search.ts)에만 있어 클라우드 모델은 미룬 도구가 있다는 것도 몰랐다.

const ROUTINE = 'mcp__daiops-mcp__routine_create'
const RULE = '무인 실행에서는 매니저 결재 큐에 제안으로 올라갑니다.'
const def = (name, description = `${name} 를 합니다. 자세한 설명.`) => ({ name, description, input_schema: {}, defer_loading: true })

describe('toolIndexText', () => {
  it('묶음 → 도구 이름 · 첫 문장, 안내 세 줄과 규칙 쓰는 법을 싣는다', () => {
    const text = toolIndexText([def('mcp__demo-wiki__page_read'), def(ROUTINE)])
    assert.ok(text.startsWith(TOOL_INDEX_GUIDE))
    assert.ok(text.includes(TOOL_INDEX_RULE_NOTE))
    assert.ok(text.includes('[daiops-mcp] 1개'))
    assert.ok(text.includes('[demo-wiki] 1개'))
    assert.ok(text.includes(`- ${ROUTINE}: ${ROUTINE} 를 합니다.`))
    assert.ok(!text.includes('자세한 설명'), '첫 문장만')
  })

  it('찾기 도구 이름을 부르지 않는다(클라우드 · 사무실의 찾기 도구 이름이 다르다)', () => {
    const text = toolIndexText([def(ROUTINE)])
    assert.ok(!/tool_search/.test(text))
    assert.ok(text.includes('도구 이름을 그대로 넣어'))
  })

  it('순서가 들어온 순서와 무관하다(대화 안에서 글이 같아야 캐시가 산다)', () => {
    const a = [def('mcp__b__x'), def('mcp__a__y'), def('mcp__a__b')]
    assert.equal(toolIndexText(a), toolIndexText([...a].reverse()))
  })

  it('상한을 넘으면 묶음 이름 · 개수만 싣는다', () => {
    const many = Array.from({ length: 400 }, (_, i) => def(`mcp__big__tool_${i}`, `${'아주 긴 설명 '.repeat(8)}.`))
    assert.ok(many.map((t) => toolIndexLine(t)).join('\n').length > TOOL_INDEX_MAX_CHARS)
    const text = toolIndexText(many)
    assert.ok(text.includes('- big: 400개'))
    assert.ok(!text.includes('tool_0'))
    assert.ok(text.startsWith(TOOL_INDEX_GUIDE))
  })
})

describe('규칙 줄(toolRules)', () => {
  it('클라우드가 보낸 규칙을 그 도구 줄에만 덧붙인다', () => {
    const rules = { [ROUTINE]: RULE }
    assert.ok(toolIndexLine(def(ROUTINE), rules).endsWith(` 규칙: ${RULE}`))
    // 바깥 서버의 같은 맨 이름에는 붙지 않는다. 키가 정식 이름이다
    assert.ok(!toolIndexLine(def('mcp__demo-erp__routine_create'), rules).includes('규칙:'))
  })

  it('첫 문장에 이미 규칙이 있으면 되풀이하지 않는다', () => {
    const line = toolIndexLine(def(ROUTINE, RULE), { [ROUTINE]: RULE })
    assert.equal(line.split(RULE).length - 1, 1)
  })

  it('handler 가 toolRules 를 문자열 값만 남겨 넘긴다', () => {
    assert.deepEqual(parseToolExposureParam({ alwaysLoadTools: ['a'], toolRules: { [ROUTINE]: RULE, x: 3, y: '' } }), {
      alwaysLoadTools: ['a'],
      toolRules: { [ROUTINE]: RULE },
    })
    assert.deepEqual(parseToolExposureParam({ alwaysLoadTools: ['a'], toolRules: ['x'] }), { alwaysLoadTools: ['a'] })
  })
})

describe('withToolIndex: 시스템 끝에 붙인다', () => {
  it('미룬 도구가 없으면 지시문을 그대로 둔다(바이트 같음)', () => {
    const system = [{ type: 'text', text: '기본 안내' }]
    assert.equal(withToolIndex(system, [{ name: 'Read' }, { name: 'mcp__a__b' }], undefined), system)
    assert.equal(withToolIndex('기본 안내', [], undefined), '기본 안내')
  })

  it('블록 배열이면 새 블록으로 덧붙인다(캐시 표시가 마지막, 목차 뒤에 붙는다)', () => {
    const out = withToolIndex([{ type: 'text', text: '기본 안내' }], [def(ROUTINE)], { toolRules: { [ROUTINE]: RULE } })
    assert.equal(out.length, 2)
    assert.equal(out[0].text, '기본 안내')
    assert.ok(out[1].text.includes(`규칙: ${RULE}`))
    assert.equal(appendToolIndex('a', 'b'), 'a\n\nb')
  })

  it('turn-manager 가 요청 지시문으로 목차 붙인 것을 쓴다(배선)', () => {
    const src = readFileSync(new URL('./turn-manager.js', import.meta.url), 'utf8')
    assert.match(src, /withToolIndex\(input\.options\.systemPrompt, effectiveTools, input\.options\.toolExposure\)/)
    assert.match(src, /systemPrompt: effectiveSystemPrompt,/)
  })
})
