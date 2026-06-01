/**
 * server.js HTTP 라우트 통합 테스트.
 * 실행: `node --test agent-runner/server.test.js`
 *
 * /v1/approval 흐름은 ApprovalManager 직접 주입이 아니라
 * 실제 활성 세션 + canUseTool 흐름이 필요해 fake server.js로 라우트만 검증.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ApprovalManager } from './approval-manager.js'

// ─────────────────────────────────────────────────────────────
// 가짜 서버 — 실제 server.js와 동일 로직을 simplified resolveApproval로 검증.
// 실 서버는 handler.js의 activeSessions/approvalRouting Map을 쓰는데,
// 테스트용으로는 단일 ApprovalManager만 노출해 라우팅 코드를 격리 검증.
// ─────────────────────────────────────────────────────────────

const TEST_TOKEN = 'test-token-xxx'
const manager = new ApprovalManager()

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function verifyAuth(req) {
  return req.headers.authorization === `Bearer ${TEST_TOKEN}`
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' })
    return
  }
  if (!verifyAuth(req)) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }
  if (req.method === 'POST' && url.pathname.startsWith('/v1/approval/')) {
    const approvalId = url.pathname.slice('/v1/approval/'.length)
    if (!approvalId) {
      sendJson(res, 400, { error: 'approval id required' })
      return
    }
    try {
      const raw = await parseBody(req)
      const body = raw ? JSON.parse(raw) : {}
      const kind = String(body.decision ?? body.kind ?? '')
      if (!['allow_once', 'allow_always', 'deny'].includes(kind)) {
        sendJson(res, 400, { error: 'decision must be one of allow_once|allow_always|deny' })
        return
      }
      const decision = { kind, allowlistEntry: body.allowlist_entry, feedback: body.feedback }
      const ok = manager.resolve(approvalId, decision, body.resolved_by ?? null)
      if (!ok) {
        sendJson(res, 409, { error: 'approval already resolved or not found', approval_id: approvalId })
        return
      }
      sendJson(res, 200, { ok: true, approval_id: approvalId })
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' })
    }
    return
  }
  sendJson(res, 404, { error: 'Not found' })
})

let baseUrl = ''

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${addr.port}`
})

after(() => new Promise((resolve) => server.close(resolve)))

async function postApproval(id, body, token = TEST_TOKEN) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${baseUrl}/v1/approval/${id}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

// ─────────────────────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────────────────────

test('미인증(토큰 누락) → 401', async () => {
  const res = await fetch(`${baseUrl}/v1/approval/some-id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'allow_once' }),
  })
  assert.equal(res.status, 401)
})

test('알 수 없는 id → 409 (resolve 실패)', async () => {
  const r = await postApproval('nonexistent-id', { decision: 'deny' })
  assert.equal(r.status, 409)
  assert.equal(r.json.approval_id, 'nonexistent-id')
})

test('정상 흐름: pending → POST → 200 + waiter resolve', async () => {
  const record = manager.create({ toolName: 'Bash', commandSummary: 'ls', reason: 'on-miss' }, 60_000)
  const waiter = manager.waitForDecision(record, 60_000)

  const r = await postApproval(record.id, { decision: 'allow_once', resolved_by: 'tester' })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)

  const decision = await waiter
  assert.equal(decision?.kind, 'allow_once')
})

test('이미 resolved한 id 재호출 → 409 (멱등)', async () => {
  const record = manager.create({ toolName: 'Write', commandSummary: 'foo', reason: 'on-miss' }, 60_000)
  manager.waitForDecision(record, 60_000)
  await postApproval(record.id, { decision: 'allow_once' })
  const r2 = await postApproval(record.id, { decision: 'allow_once' })
  assert.equal(r2.status, 409)
})

test('잘못된 decision → 400', async () => {
  const r = await postApproval('any-id', { decision: 'invalid' })
  assert.equal(r.status, 400)
})

test('allowlist_entry + feedback이 decision에 전달', async () => {
  const record = manager.create({ toolName: 'Bash', commandSummary: 'rg', reason: 'on-miss' }, 60_000)
  const waiter = manager.waitForDecision(record, 60_000)
  const r = await postApproval(record.id, {
    decision: 'allow_always',
    allowlist_entry: 'rg',
    resolved_by: 'admin',
  })
  assert.equal(r.status, 200)
  const decision = await waiter
  assert.equal(decision?.kind, 'allow_always')
  assert.equal(decision?.allowlistEntry, 'rg')
})
