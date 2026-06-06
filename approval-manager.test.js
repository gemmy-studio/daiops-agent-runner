/**
 * ApprovalManager 단위 테스트.
 * 실행: `node --test agent-runner/approval-manager.test.js`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalManager } from './approval-manager.js'

const REQUEST = {
  toolName: 'Bash',
  commandSummary: 'rm -rf /workspace/foo',
  reason: 'risky-default',
  sessionId: 'sess-1',
}

test('create → waitForDecision → resolve 즉시 반환', async () => {
  const mgr = new ApprovalManager()
  const record = mgr.create(REQUEST, 60_000)
  const pending = mgr.waitForDecision(record, 60_000)

  assert.equal(mgr.pendingIds().length, 1)
  const ok = mgr.resolve(record.id, { kind: 'allow_once' }, 'user-123')
  assert.equal(ok, true)

  const decision = await pending
  assert.deepEqual(decision, { kind: 'allow_once' })
  assert.equal(mgr.pendingIds().length, 0)
})

test('timeout 경과 시 null 반환 + Map 자동 정리', async () => {
  const mgr = new ApprovalManager()
  const record = mgr.create(REQUEST, 50)
  assert.equal(mgr.pendingIds().length, 0)

  const result = await mgr.waitForDecision(record, 50)
  assert.equal(result, null)
  assert.equal(mgr.pendingIds().length, 0, 'timeout 후 Map 비어야 함')
})

test('이미 resolve된 id 재호출 시 false (멱등)', async () => {
  const mgr = new ApprovalManager()
  const record = mgr.create(REQUEST, 60_000)
  const waiter = mgr.waitForDecision(record, 60_000)

  const first = mgr.resolve(record.id, { kind: 'deny' })
  const second = mgr.resolve(record.id, { kind: 'allow_once' })

  assert.equal(first, true)
  assert.equal(second, false)
  const decision = await waiter
  assert.deepEqual(decision, { kind: 'deny' })
})

test('resolve 미경유 id는 false', () => {
  const mgr = new ApprovalManager()
  const ok = mgr.resolve('nonexistent', { kind: 'allow_once' })
  assert.equal(ok, false)
})

test('caller가 지정한 id는 그대로 사용 (DB 매칭용)', () => {
  const mgr = new ApprovalManager()
  const record = mgr.create(REQUEST, 60_000, 'custom-id-abc')
  assert.equal(record.id, 'custom-id-abc')
})


test('decision에 allowlistEntry 포함 (allow_always 케이스)', async () => {
  const mgr = new ApprovalManager()
  const record = mgr.create(REQUEST, 60_000)
  const waiter = mgr.waitForDecision(record, 60_000)

  mgr.resolve(record.id, { kind: 'allow_always', allowlistEntry: 'rm' }, 'user-456')
  const decision = await waiter
  assert.equal(decision?.kind, 'allow_always')
  assert.equal(decision?.allowlistEntry, 'rm')
})
