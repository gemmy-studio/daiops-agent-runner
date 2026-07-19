import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { CertManager, isValidHostname } from './cert-manager.js'

const execFileP = promisify(execFile)

describe('isValidHostname', () => {
  it('유효한 호스트 허용', () => {
    assert.ok(isValidHostname('api.stripe.com'))
    assert.ok(isValidHostname('a-b.example.co.kr'))
  })
  it('무효/인젝션 시도 거부', () => {
    assert.ok(!isValidHostname(''))
    assert.ok(!isValidHostname('a b.com'))
    assert.ok(!isValidHostname('a;rm -rf.com'))
    assert.ok(!isValidHostname('a/..b.com'))
    assert.ok(!isValidHostname('x'.repeat(300)))
  })
})

describe('CertManager (실제 openssl)', () => {
  let dir
  let cm

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'certmgr-test-'))
    cm = new CertManager({ baseDir: dir })
    await cm.init()
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('CA 인증서 생성', () => {
    assert.match(cm.caCertPem, /BEGIN CERTIFICATE/)
  })

  it('호스트 leaf 인증서가 CA로 검증됨 + SAN 포함', async () => {
    await cm.getSecureContext('api.stripe.com')
    const certPath = path.join(dir, 'api.stripe.com.crt')

    // 체인 검증
    const verify = await execFileP('openssl', ['verify', '-CAfile', cm.caCertPath, certPath])
    assert.match(verify.stdout, /OK/)

    // SAN 확인
    const text = await execFileP('openssl', ['x509', '-in', certPath, '-noout', '-text'])
    assert.match(text.stdout, /DNS:api\.stripe\.com/)
  })

  it('SecureContext 캐시 — 같은 호스트는 동일 인스턴스', async () => {
    const a = await cm.getSecureContext('api.github.com')
    const b = await cm.getSecureContext('api.github.com')
    assert.equal(a, b)
  })

  it('동시 요청 dedup — 병렬 호출도 1회 민팅', async () => {
    const [a, b, c] = await Promise.all([
      cm.getSecureContext('x.example.com'),
      cm.getSecureContext('x.example.com'),
      cm.getSecureContext('x.example.com'),
    ])
    assert.equal(a, b)
    assert.equal(b, c)
  })

  it('무효 호스트는 throw', async () => {
    await assert.rejects(() => cm.getSecureContext('bad host;rm'))
  })
})
