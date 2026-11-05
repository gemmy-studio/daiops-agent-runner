import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REMEMBER_TOOL,
  isValidRememberContent,
  REMEMBER_CONTENT_MAX,
  REMEMBER_ACTIONS,
  REMEMBER_FAILURES,
  isRememberAction,
  isRememberFailure,
  rememberDecisionFromBody,
  blockedRememberGuidance,
  DEFAULT_BLOCKED_GUIDANCE,
  GUIDANCE_MAX,
} from './remember.js'

test('REMEMBER_TOOL: Anthropic 호환 스키마', () => {
  assert.equal(REMEMBER_TOOL.name, 'remember')
  assert.equal(REMEMBER_TOOL.input_schema.type, 'object')
  assert.deepEqual(REMEMBER_TOOL.input_schema.required, ['content'])
  assert.ok(REMEMBER_TOOL.input_schema.properties.content)
  assert.ok(Object.isFrozen(REMEMBER_TOOL))
})

test('isValidRememberContent: 유효한 본문', () => {
  assert.equal(isValidRememberContent('보고서는 항상 출처를 명시한다'), true)
  assert.equal(isValidRememberContent('a'), true)
  assert.equal(isValidRememberContent('x'.repeat(REMEMBER_CONTENT_MAX)), true)
})

test('isValidRememberContent: 무효한 본문은 거부', () => {
  assert.equal(isValidRememberContent(''), false)
  assert.equal(isValidRememberContent('   '), false) // 공백만
  assert.equal(isValidRememberContent('x'.repeat(REMEMBER_CONTENT_MAX + 1)), false) // 초과
  assert.equal(isValidRememberContent(123), false)
  assert.equal(isValidRememberContent(undefined), false)
  assert.equal(isValidRememberContent(null), false)
})

test('REMEMBER_ACTIONS: 4종을 정확히 담는다 — cloud RememberAction과 짝', () => {
  assert.deepEqual([...REMEMBER_ACTIONS], ['saved', 'duplicate', 'failed', 'blocked'])
  assert.ok(Object.isFrozen(REMEMBER_ACTIONS))
  assert.equal(isRememberAction('blocked'), true)
  assert.equal(isRememberAction('removed'), false) // memory-edit의 어휘 — 섞이면 안 된다
  assert.equal(isRememberAction('unknown'), false)
})

test('isRememberFailure: blocked는 실패류, duplicate는 아니다', () => {
  assert.deepEqual([...REMEMBER_FAILURES], ['failed', 'blocked'])
  assert.equal(isRememberFailure('failed'), true)
  // 정책 거부 — 저장은 안 됐으므로 deny로 다뤄야 한다(성공으로 보고하면 LLM이 저장됐다고 답한다).
  assert.equal(isRememberFailure('blocked'), true)
  // 정상 처리됐고 결과가 "이미 있음"인 것 — 실패가 아니다.
  assert.equal(isRememberFailure('duplicate'), false)
  assert.equal(isRememberFailure('saved'), false)
})

// 11/05: blocked 안내는 cloud 가 사유에 맞춰 보낸다(숙달 꺼짐 · 기본 규칙 고정 · 승인함에 올림). 옛 cloud 면 종전 문구
test('rememberDecisionFromBody: blocked 는 사유와 cloud 안내를 싣고, 성공류는 싣지 않는다', () => {
  assert.deepEqual(rememberDecisionFromBody('blocked', { reason: 'learning_off', guidance: '  저장하지 않았습니다  ' }), {
    kind: 'deny',
    rememberAction: 'blocked',
    blockedReason: 'learning_off',
    guidance: '저장하지 않았습니다',
  })
  assert.deepEqual(rememberDecisionFromBody('saved', { guidance: 'x' }), { kind: 'allow_once', rememberAction: 'saved' })
  assert.equal(rememberDecisionFromBody('blocked', { guidance: '   ' }).guidance, null)
  assert.equal(rememberDecisionFromBody('blocked', {}).guidance, null)
  assert.equal(rememberDecisionFromBody('blocked', { guidance: 'a'.repeat(GUIDANCE_MAX + 50) }).guidance.length, GUIDANCE_MAX)
})

test('blockedRememberGuidance: cloud 안내가 있으면 그것, 없으면 종전 문구', () => {
  assert.equal(blockedRememberGuidance({ guidance: '승인함에 올렸습니다' }), '승인함에 올렸습니다')
  assert.equal(blockedRememberGuidance({ guidance: null }), DEFAULT_BLOCKED_GUIDANCE)
  assert.equal(blockedRememberGuidance(undefined), DEFAULT_BLOCKED_GUIDANCE)
})
