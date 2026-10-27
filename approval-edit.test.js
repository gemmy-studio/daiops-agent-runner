/**
 * 결재 카드에서 고쳐 승인하기(0.34.0). 결재 요청에 원래 인자를 싣고, 승인에 실린 고친 칸을 얹어 실행한다.
 * 실행: `node --test approval-edit.test.js`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalManager, readUpdatedInput } from './approval-manager.js'
import { mergeEditedInput, toolInputField, PLAN_TOOL_INPUT_MAX_BYTES } from './handler.js'

const MAIL = { to: 'kim@client.com', subject: '회의 후속', body: '안녕하세요', attachments: ['/workspace/a.pdf'] }

test('toolInputField: 객체 인자는 tool_input 으로 싣는다', () => {
  assert.deepEqual(toolInputField(MAIL), { tool_input: MAIL })
})

test('toolInputField: 너무 큰 인자 · 객체가 아닌 값은 싣지 않는다', () => {
  assert.deepEqual(toolInputField({ body: 'a'.repeat(PLAN_TOOL_INPUT_MAX_BYTES + 1) }), {})
  assert.deepEqual(toolInputField('rm -rf /'), {})
  assert.deepEqual(toolInputField(['a']), {})
  assert.deepEqual(toolInputField(null), {})
})

test('mergeEditedInput: 고친 문자열 칸만 원래 인자에 얹고 나머지 칸은 그대로', () => {
  const merged = mergeEditedInput(MAIL, { to: 'lee@client.com', body: '수정본' })
  assert.deepEqual(merged, { ...MAIL, to: 'lee@client.com', body: '수정본' })
  assert.deepEqual(MAIL.to, 'kim@client.com') // 원래 객체는 바꾸지 않는다
})

test('mergeEditedInput: 문자열이 아닌 값(첨부 바꿔치기 등)은 얹지 않는다', () => {
  const merged = mergeEditedInput(MAIL, { attachments: ['/etc/passwd'], body: '수정본' })
  assert.deepEqual(merged.attachments, ['/workspace/a.pdf'])
  assert.equal(merged.body, '수정본')
})

test('mergeEditedInput: 고친 값이 없으면 원래 인자 그대로', () => {
  assert.equal(mergeEditedInput(MAIL, undefined), MAIL)
  assert.equal(mergeEditedInput(MAIL, ['x']), MAIL)
})

test('readUpdatedInput: 허용일 때 객체만 받는다', () => {
  assert.deepEqual(readUpdatedInput({ updated_input: { body: 'x' } }, 'allow_once'), { body: 'x' })
  assert.equal(readUpdatedInput({ updated_input: ['x'] }, 'allow_once'), undefined)
  assert.equal(readUpdatedInput({ updated_input: 'x' }, 'allow_once'), undefined)
  assert.equal(readUpdatedInput({}, 'allow_once'), undefined)
})

test('readUpdatedInput: 거절에는 실려 와도 쓰지 않는다', () => {
  assert.equal(readUpdatedInput({ updated_input: { body: 'x' } }, 'deny'), undefined)
})

test('ApprovalManager: 승인에 실린 고친 인자가 기다리던 쪽에 그대로 간다', async () => {
  const m = new ApprovalManager()
  const record = m.create({ toolName: 'mcp__daiops-mcp__mail_send', commandSummary: '→ kim', reason: 'outward-send' }, 5_000)
  const waiting = m.waitForDecision(record, 5_000)
  m.resolve(record.id, { kind: 'allow_once', updatedInput: { body: '수정본' } }, 'user-1')
  const decision = await waiting
  assert.deepEqual(decision?.updatedInput, { body: '수정본' })
  assert.deepEqual(mergeEditedInput(MAIL, decision?.updatedInput).body, '수정본')
})

// 배선: canUseTool 의 결재 갈래가 두 함수를 실제로 부르는가. 그 갈래는 handleChat 전체를 띄워야 닿아 단위 시험이 덮지 못한다
test('배선: 결재 요청에 원래 인자를 싣고, 허용하면 고친 칸을 얹어 실행한다', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('./handler.js', import.meta.url), 'utf8')
  const planBlock = src.slice(src.indexOf("emitSseEvent(sessionId, 'plan_request'"), src.indexOf('const result = await approvalManager.waitForDecision(record, approvalTimeoutMs)'))
  assert.match(planBlock, /\.\.\.toolInputField\(input\)/)
  assert.match(src, /updatedInput: applyCacheRedirectCorrection\(toolName, mergeEditedInput\(input, result\.updatedInput\)\)/)
})
