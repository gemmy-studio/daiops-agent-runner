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

test('resolveAllPending → 대기 중 모든 decision을 deny로 즉시 해소 + Map 비움', async () => {
  const mgr = new ApprovalManager()
  const r1 = mgr.create({ ...REQUEST, sessionId: 's' }, 60_000)
  const r2 = mgr.create({ ...REQUEST, sessionId: 's' }, 60_000)
  const w1 = mgr.waitForDecision(r1, 60_000)
  const w2 = mgr.waitForDecision(r2, 60_000)
  assert.equal(mgr.pendingIds().length, 2)

  const ids = mgr.resolveAllPending('Aborted: user_abort')
  assert.equal(ids.length, 2)
  assert.deepEqual([...ids].sort(), [r1.id, r2.id].sort())

  const [d1, d2] = await Promise.all([w1, w2])
  assert.equal(d1?.kind, 'deny')
  assert.equal(d2?.kind, 'deny')
  assert.equal(d1?.feedback, 'Aborted: user_abort')
  assert.equal(mgr.pendingIds().length, 0, '해소 후 Map 비어야 함')
})

test('resolveAllPending 후 같은 id resolve는 false (이미 해소, timer 누수 없음)', async () => {
  const mgr = new ApprovalManager()
  const record = mgr.create(REQUEST, 60_000)
  const waiter = mgr.waitForDecision(record, 60_000)

  mgr.resolveAllPending()
  const decision = await waiter
  assert.equal(decision?.kind, 'deny')
  // 이미 해소됐으므로 후속 resolve는 멱등하게 false
  assert.equal(mgr.resolve(record.id, { kind: 'allow_once' }), false)
})

test('pending 없을 때 resolveAllPending → 빈 배열', () => {
  const mgr = new ApprovalManager()
  assert.deepEqual(mgr.resolveAllPending(), [])
})
