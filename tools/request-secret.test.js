import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REQUEST_SECRET_TOOL, isValidSecretKey, isReservedKey } from './request-secret.js'

test('isValidSecretKey: 유효한 키 (대문자 시작, 영대문자/숫자/밑줄)', () => {
  assert.equal(isValidSecretKey('STRIPE_API_KEY'), true)
  assert.equal(isValidSecretKey('A'), true)
  assert.equal(isValidSecretKey('OPENAI_API_KEY_1'), true)
  assert.equal(isValidSecretKey('DB_URL'), true)
})

test('isValidSecretKey: 무효한 키는 거부', () => {
  assert.equal(isValidSecretKey('stripe_key'), false) // 소문자
  assert.equal(isValidSecretKey('1KEY'), false) // 숫자 시작
  assert.equal(isValidSecretKey('KEY-NAME'), false) // 하이픈
  assert.equal(isValidSecretKey('KEY NAME'), false) // 공백
  assert.equal(isValidSecretKey(''), false)
  assert.equal(isValidSecretKey(123), false)
  assert.equal(isValidSecretKey(undefined), false)
  assert.equal(isValidSecretKey(null), false)
})

test('isReservedKey: 시스템·인프라 예약어 거부 (대소문자·prefix 포함)', () => {
  assert.equal(isReservedKey('PATH'), true)
  assert.equal(isReservedKey('HOME'), true)
  assert.equal(isReservedKey('NODE_OPTIONS'), true)
  assert.equal(isReservedKey('LLM_PROXY_URL'), true)
  assert.equal(isReservedKey('WORKSPACE_ID'), true)
  assert.equal(isReservedKey('AGENT_RUNNER_TOKEN'), true)
  assert.equal(isReservedKey('ANTHROPIC_API_KEY'), true)
  assert.equal(isReservedKey('LD_PRELOAD'), true) // LD_ prefix
  assert.equal(isReservedKey('DYLD_INSERT_LIBRARIES'), true) // DYLD_ prefix
  assert.equal(isReservedKey('DAIOPS_ANYTHING'), true) // DAIOPS_ prefix
  assert.equal(isReservedKey('path'), true) // 대소문자 무시
})

test('isReservedKey: 일반 사용자 secret은 허용', () => {
  assert.equal(isReservedKey('STRIPE_API_KEY'), false)
  assert.equal(isReservedKey('OPENAI_API_KEY'), false)
  assert.equal(isReservedKey('MY_SERVICE_TOKEN'), false)
  assert.equal(isReservedKey(undefined), false)
  assert.equal(isReservedKey(null), false)
})

test('REQUEST_SECRET_TOOL: Anthropic tool 스키마', () => {
  assert.equal(REQUEST_SECRET_TOOL.name, 'request_secret')
  assert.equal(REQUEST_SECRET_TOOL.input_schema.type, 'object')
  assert.deepEqual(REQUEST_SECRET_TOOL.input_schema.required, ['key_name'])
  assert.ok(REQUEST_SECRET_TOOL.input_schema.properties.key_name)
  assert.ok(REQUEST_SECRET_TOOL.input_schema.properties.reason)
  // 설명에 "값은 모델에 노출되지 않" 원칙이 명시돼 있어야 LLM이 채팅 직접 입력 요구를 피한다.
  assert.match(REQUEST_SECRET_TOOL.description, /노출되지 않/)
})
