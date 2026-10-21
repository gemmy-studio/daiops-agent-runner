/**
 * forget·revise 도구 단위 테스트 (ADR 31).
 * 핵심은 `resolveMemoryOps`의 **하위호환 기본값** — 구버전 cloud에 도구를 노출하면
 * LLM 호출이 결재 타임아웃까지 매달린다.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FORGET_TOOL,
  REVISE_TOOL,
  isValidRuleText,
  MEMORY_RULE_MAX,
  resolveMemoryOps,
  MEMORY_EDIT_ACTIONS,
  isMemoryEditAction,
  isMemoryEditFailure,
  readRuleTarget,
  sanitizeMemoryDetail,
  formatRuleList,
} from './memory-edit.js'

describe('resolveMemoryOps — 하위호환 게이트', () => {
  it('미지정(구버전 cloud)이면 둘 다 노출하지 않는다', () => {
    assert.deepEqual(resolveMemoryOps(undefined), { forget: false, revise: false })
    assert.deepEqual(resolveMemoryOps(null), { forget: false, revise: false })
  })

  it('선언한 연산만 노출한다', () => {
    assert.deepEqual(resolveMemoryOps(['forget']), { forget: true, revise: false })
    assert.deepEqual(resolveMemoryOps(['revise']), { forget: false, revise: true })
    assert.deepEqual(resolveMemoryOps(['forget', 'revise']), { forget: true, revise: true })
  })

  it('remember만 선언해도 편집 도구는 안 열린다', () => {
    assert.deepEqual(resolveMemoryOps(['remember']), { forget: false, revise: false })
  })

  it('배열이 아닌 값·비문자열 원소는 무시한다', () => {
    assert.deepEqual(resolveMemoryOps('forget'), { forget: false, revise: false })
    assert.deepEqual(resolveMemoryOps({ forget: true }), { forget: false, revise: false })
    assert.deepEqual(resolveMemoryOps([1, null, 'forget']), { forget: true, revise: false })
  })
})

describe('isValidRuleText', () => {
  it('빈 문자열·공백만·비문자열을 거부한다', () => {
    assert.equal(isValidRuleText(''), false)
    assert.equal(isValidRuleText('   '), false)
    assert.equal(isValidRuleText(undefined), false)
    assert.equal(isValidRuleText(123), false)
  })

  it('상한 이내는 통과, 초과는 거부', () => {
    assert.equal(isValidRuleText('규칙'), true)
    assert.equal(isValidRuleText('가'.repeat(MEMORY_RULE_MAX)), true)
    assert.equal(isValidRuleText('가'.repeat(MEMORY_RULE_MAX + 1)), false)
  })
})

describe('action 어휘 — cloud MemoryEditAction과의 계약', () => {
  it('9종을 정확히 담는다 — cloud harness/remember-instruction.ts MemoryEditAction과 짝', () => {
    assert.deepEqual([...MEMORY_EDIT_ACTIONS], [
      'removed', 'revised', 'protected', 'duplicate', 'not_found', 'failed', 'blocked', 'queued', 'stale',
    ])
  })

  it('계약 밖 값을 거부한다', () => {
    assert.equal(isMemoryEditAction('removed'), true)
    assert.equal(isMemoryEditAction('saved'), false) // remember의 어휘 — 섞이면 안 된다
    assert.equal(isMemoryEditAction(''), false)
    assert.equal(isMemoryEditAction('REMOVED'), false)
  })

  it('protected·duplicate는 실패가 아니다 — 정상 처리됐고 결과가 그것', () => {
    // deny로 매핑하면 LLM이 오류로 받아 재시도한다. 보호는 "그대로 두라"는 정상 응답이다.
    assert.equal(isMemoryEditFailure('protected'), false)
    assert.equal(isMemoryEditFailure('duplicate'), false)
    assert.equal(isMemoryEditFailure('removed'), false)
    assert.equal(isMemoryEditFailure('revised'), false)
  })

  it('failed·not_found·stale 만 실패로 다룬다. queued 는 정상 처리(승인함에 올림)다', () => {
    assert.equal(isMemoryEditFailure('failed'), true)
    assert.equal(isMemoryEditFailure('not_found'), true)
    assert.equal(isMemoryEditFailure('stale'), true)
    assert.equal(isMemoryEditFailure('queued'), false)
  })

  it('어휘 목록은 동결돼 있다', () => {
    assert.equal(Object.isFrozen(MEMORY_EDIT_ACTIONS), true)
  })
})

describe('도구 정의', () => {
  it('forget 은 본문(content)이나 목록 번호(number + list_version)로 짚는다(0.30.0)', () => {
    assert.equal(FORGET_TOOL.name, 'forget')
    assert.deepEqual(FORGET_TOOL.input_schema.required, [])
    assert.ok(FORGET_TOOL.input_schema.properties.number)
    assert.ok(FORGET_TOOL.input_schema.properties.list_version)
  })

  it('revise 는 new_content 를 필수로, 대상은 content 나 번호로 짚는다', () => {
    assert.equal(REVISE_TOOL.name, 'revise')
    assert.deepEqual(REVISE_TOOL.input_schema.required, ['new_content'])
    assert.ok(REVISE_TOOL.input_schema.properties.number)
  })

  it('설명이 「없다」고 답하기 전에 목록을 보라고 한다(daiops 10/20 세션 839ae5be)', () => {
    assert.match(FORGET_TOOL.description, /그런 규칙이 없다/)
    assert.match(FORGET_TOOL.description, /규칙마다 한 번씩/)
  })

  it('설명에 보호 규칙 안내가 있다 — LLM이 거부를 오류로 오해하지 않도록', () => {
    assert.match(FORGET_TOOL.description, /사용자가 직접 지정한 규칙은 보호/)
    assert.match(REVISE_TOOL.description, /사용자가 직접 지정한 규칙은 보호/)
  })

  it('정의는 동결돼 있다 — 런타임 변조 방지', () => {
    assert.equal(Object.isFrozen(FORGET_TOOL), true)
    assert.equal(Object.isFrozen(REVISE_TOOL), true)
  })
})

describe('짚기 · 재료(0.30.0)', () => {
  it('번호와 판 표시가 함께 있으면 번호로, 아니면 본문으로 짚는다', () => {
    assert.deepEqual(readRuleTarget({ number: 2, list_version: 'ab' }), { number: 2, list_version: 'ab' })
    assert.deepEqual(readRuleTarget({ content: ' 출처를 단다 ' }), { content: '출처를 단다' })
    assert.deepEqual(readRuleTarget({ number: 2 }), null)
    assert.equal(readRuleTarget({ number: 0, list_version: 'ab' }), null)
    assert.equal(readRuleTarget({}), null)
  })

  it('cloud 재료를 믿을 모양으로 깎는다(모르는 칸 · 잘못된 타입은 버린다)', () => {
    const d = sanitizeMemoryDetail({ rules: ['a', 3, 'b'], listVersion: 'v1', closest: 2, queued: true, removed: 'x', evil: 'y' })
    assert.deepEqual(d, { rules: ['a', 'b'], listVersion: 'v1', closest: 2, queued: true, removed: 'x' })
    assert.deepEqual(sanitizeMemoryDetail(undefined), {})
    assert.deepEqual(sanitizeMemoryDetail({ closest: -1, stale: 'yes' }), {})
  })

  it('실패 응답 목록은 번호 · 판 표시 · 후보 · 「없다」 전에 확인하라는 말을 담는다', () => {
    const text = formatRuleList({ rules: ['출처를 단다', '고객 문의는 한 줄로'], listVersion: 'v1', closest: 2 })
    assert.match(text, /1\. 출처를 단다/)
    assert.match(text, /2\. 고객 문의는 한 줄로/)
    assert.match(text, /list_version="v1"/)
    assert.match(text, /2번/)
    assert.match(text, /그런 규칙이 없다/)
    assert.match(formatRuleList({}), /규칙이 없어요/)
  })
})
