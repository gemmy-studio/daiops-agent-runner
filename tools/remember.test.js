import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REMEMBER_TOOL, isValidRememberContent, REMEMBER_CONTENT_MAX } from './remember.js'

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
