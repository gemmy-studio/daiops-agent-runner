import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { postTerminalIngest } from './ingest-client.js'

function withEnv(env, fn) {
  const keys = ['LLM_PROXY_URL', 'AGENT_RUNNER_TOKEN', 'WORKSPACE_ID']
  const saved = {}
  for (const k of keys) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  return Promise.resolve(fn()).finally(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  })
}

const ENV = {
  LLM_PROXY_URL: 'https://cloud.example/api/internal/llm/messages',
  AGENT_RUNNER_TOKEN: 'ws-tok',
  WORKSPACE_ID: 'ws-1',
}

describe('postTerminalIngest', () => {
  it('env 미설정 → no-op false (호출 안 함)', async () => {
    await withEnv({ LLM_PROXY_URL: undefined, AGENT_RUNNER_TOKEN: undefined, WORKSPACE_ID: undefined }, async () => {
      let called = false
      const r = await postTerminalIngest({ messageId: 'm1', seq: 3, status: 'completed', content: 'x' }, async () => { called = true; return new Response('{}') })
      assert.equal(r, false)
      assert.equal(called, false)
    })
  })

  it('messageId 없으면 → no-op false', async () => {
    await withEnv(ENV, async () => {
      let called = false
      const r = await postTerminalIngest({ messageId: '', seq: 3, status: 'completed', content: 'x' }, async () => { called = true; return new Response('{}') })
      assert.equal(r, false)
      assert.equal(called, false)
    })
  })

  it('completed terminal → origin + /api/internal/ingest로 인증 헤더 POST', async () => {
    await withEnv(ENV, async () => {
      let captured
      const r = await postTerminalIngest(
        { messageId: 'm1', seq: 12, status: 'completed', content: '결과입니다' },
        async (url, init) => { captured = { url, init }; return new Response('{}', { status: 200 }) },
      )
      assert.equal(r, true)
      assert.equal(captured.url, 'https://cloud.example/api/internal/ingest')
      assert.equal(captured.init.method, 'POST')
      assert.equal(captured.init.headers['authorization'], 'Bearer ws-tok')
      assert.equal(captured.init.headers['x-workspace-id'], 'ws-1')
      const body = JSON.parse(captured.init.body)
      assert.equal(body.messageId, 'm1')
      assert.equal(body.seq, 12)
      assert.equal(body.status, 'completed')
      assert.equal(body.terminal, true)
      assert.equal(body.content, '결과입니다')
      assert.equal('errorCode' in body, false)
    })
  })

  it('error terminal → status=error + errorCode 포함', async () => {
    await withEnv(ENV, async () => {
      let body
      const r = await postTerminalIngest(
        { messageId: 'm2', seq: 5, status: 'error', content: '', errorCode: 'rate_limit' },
        async (_url, init) => { body = JSON.parse(init.body); return new Response('{}', { status: 200 }) },
      )
      assert.equal(r, true)
      assert.equal(body.status, 'error')
      assert.equal(body.terminal, true)
      assert.equal(body.errorCode, 'rate_limit')
    })
  })

  it('잘못된 status는 completed로 정규화, 음수 seq는 0으로', async () => {
    await withEnv(ENV, async () => {
      let body
      await postTerminalIngest(
        { messageId: 'm3', seq: -1, status: 'weird', content: 'x' },
        async (_url, init) => { body = JSON.parse(init.body); return new Response('{}', { status: 200 }) },
      )
      assert.equal(body.status, 'completed')
      assert.equal(body.seq, 0)
    })
  })

  it('upstream !ok → false', async () => {
    await withEnv(ENV, async () => {
      const r = await postTerminalIngest({ messageId: 'm1', seq: 1, status: 'completed', content: 'x' }, async () => new Response('err', { status: 500 }))
      assert.equal(r, false)
    })
  })

  it('fetch throw → fail-soft false (예외 안 던짐)', async () => {
    await withEnv(ENV, async () => {
      const r = await postTerminalIngest({ messageId: 'm1', seq: 1, status: 'completed', content: 'x' }, async () => { throw new Error('network') })
      assert.equal(r, false)
    })
  })
})
