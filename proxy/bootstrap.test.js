import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  shellSingleQuote,
  renderIntegrationsEnv,
  fetchMaterializedSecrets,
  startInjectionBroker,
  writePlaceholderEnvFile,
} from './bootstrap.js'
import { PLACEHOLDER_PREFIX } from './injection-core.js'

describe('shellSingleQuote', () => {
  it('작은따옴표 이스케이프', () => {
    assert.equal(shellSingleQuote("a'b"), "'a'\\''b'")
  })
})

describe('renderIntegrationsEnv', () => {
  it('placeholder만 export (진짜 값 없음)', () => {
    const m = new Map([['STRIPE_KEY', 'dai_phantom_abc']])
    const out = renderIntegrationsEnv(m)
    assert.match(out, /export STRIPE_KEY='dai_phantom_abc'/)
    assert.match(out, /placeholders only/)
  })
})

describe('fetchMaterializedSecrets', () => {
  it('Bearer + x-workspace-id로 요청, data.secrets 반환', async () => {
    let captured
    const fetchFn = async (url, opts) => {
      captured = { url, opts }
      return { ok: true, json: async () => ({ data: { secrets: [{ key: 'K', value: 'v', allowedHosts: ['h'] }] } }) }
    }
    const secrets = await fetchMaterializedSecrets({
      proxyOrigin: 'https://cloud.example.com/', workspaceId: 'ws1', token: 'tok', fetchFn,
    })
    assert.equal(captured.url, 'https://cloud.example.com/api/internal/secrets/materialize')
    assert.equal(captured.opts.headers.authorization, 'Bearer tok')
    assert.equal(captured.opts.headers['x-workspace-id'], 'ws1')
    assert.deepEqual(secrets, [{ key: 'K', value: 'v', allowedHosts: ['h'] }])
  })
  it('HTTP 에러는 throw', async () => {
    const fetchFn = async () => ({ ok: false, status: 401 })
    await assert.rejects(() => fetchMaterializedSecrets({
      proxyOrigin: 'https://c', workspaceId: 'w', token: 't', fetchFn,
    }), /HTTP 401/)
  })
  it('secrets 누락 시 빈 배열', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => ({ data: {} }) })
    assert.deepEqual(await fetchMaterializedSecrets({ proxyOrigin: 'https://c', workspaceId: 'w', token: 't', fetchFn }), [])
  })
})

describe('startInjectionBroker + writePlaceholderEnvFile', () => {
  let dir, broker
  after(async () => {
    await broker?.proxy?.stop()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('프록시 기동 + placeholder 맵/파일 생성', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bootstrap-test-'))
    broker = await startInjectionBroker({
      secrets: [{ key: 'API_KEY', value: 'real123', allowedHosts: ['api.x.com'] }],
    })
    assert.match(broker.proxyUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    const ph = broker.placeholderByKey.get('API_KEY')
    assert.ok(ph.startsWith(PLACEHOLDER_PREFIX))
    // injectionMap엔 진짜 값, placeholderByKey엔 placeholder
    assert.equal(broker.injectionMap.get(ph).realValue, 'real123')

    const envPath = path.join(dir, '.integrations.env')
    await writePlaceholderEnvFile(envPath, broker.placeholderByKey)
    const content = await readFile(envPath, 'utf-8')
    assert.match(content, new RegExp(`export API_KEY='${ph}'`))
    assert.ok(!content.includes('real123')) // 진짜 값 파일에 없음
  })
})
