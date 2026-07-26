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
  it('6종을 정확히 담는다 — cloud harness/remember-instruction.ts MemoryEditAction과 짝', () => {
    assert.deepEqual([...MEMORY_EDIT_ACTIONS], [
      'removed', 'revised', 'protected', 'duplicate', 'not_found', 'failed',
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

  it('failed·not_found만 실패로 다룬다', () => {
    assert.equal(isMemoryEditFailure('failed'), true)
    assert.equal(isMemoryEditFailure('not_found'), true)
  })

  it('어휘 목록은 동결돼 있다', () => {
    assert.equal(Object.isFrozen(MEMORY_EDIT_ACTIONS), true)
  })
})

describe('도구 정의', () => {
  it('forget은 content 하나를 필수로 받는다', () => {
    assert.equal(FORGET_TOOL.name, 'forget')
    assert.deepEqual(FORGET_TOOL.input_schema.required, ['content'])
  })

  it('revise는 content + new_content를 필수로 받는다', () => {
    assert.equal(REVISE_TOOL.name, 'revise')
    assert.deepEqual(REVISE_TOOL.input_schema.required, ['content', 'new_content'])
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
