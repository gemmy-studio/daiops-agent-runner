import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { CertManager } from './cert-manager.js'
import { buildInjectionMap } from './injection-core.js'
import { InjectionProxy } from './injection-proxy.js'

const execFileP = promisify(execFile)

/** localhost용 자체 서명 인증서(업스트림 서버 역할) 생성. */
async function makeSelfSigned(dir) {
  const keyPath = path.join(dir, 'up.key')
  const crtPath = path.join(dir, 'up.crt')
  await execFileP('openssl', ['req', '-x509', '-newkey', 'ec',
    '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', keyPath, '-out', crtPath, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'])
  return { key: await readFile(keyPath), cert: await readFile(crtPath) }
}

/** 프록시를 통해 CONNECT MITM으로 요청을 보내고 응답 바디(JSON)를 파싱. */
function requestThroughProxy({ proxyPort, upstreamPort, caPem, authHeader }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method: 'CONNECT',
      path: `localhost:${upstreamPort}`,
    })
    req.on('error', reject)
    req.on('connect', (_res, socket) => {
      const t = tls.connect({ socket, servername: 'localhost', ca: caPem }, () => {
        t.write(
          `GET / HTTP/1.1\r\nHost: localhost:${upstreamPort}\r\n` +
          `Authorization: ${authHeader}\r\nConnection: close\r\n\r\n`,
        )
      })
      let data = ''
      t.on('data', (d) => (data += d))
      t.on('end', () => {
        const statusMatch = data.match(/^HTTP\/\d\.\d (\d+)/)
        const status = statusMatch ? Number(statusMatch[1]) : 0
        // chunked 인코딩일 수 있어 JSON 본문만 견고하게 추출({ ... })
        const start = data.indexOf('{')
        const end = data.lastIndexOf('}')
        const body = start >= 0 && end > start ? data.slice(start, end + 1) : data
        try { resolve({ status, json: JSON.parse(body) }) } catch { reject(new Error(`parse: ${data}`)) }
      })
      t.on('error', reject)
    })
    req.end()
  })
}

describe('InjectionProxy — CONNECT MITM + 치환 (실제 TLS)', () => {
  let dir, cm, upstream, upstreamPort, proxy, proxyPort, upCa

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'proxy-test-'))
    cm = new CertManager({ baseDir: dir })
    await cm.init()

    // 업스트림 — 받은 Authorization 헤더를 그대로 에코
    const { key, cert } = await makeSelfSigned(dir)
    upCa = cert
    upstream = https.createServer({ key, cert }, (r, s) => {
      s.writeHead(200, { 'content-type': 'application/json' })
      s.end(JSON.stringify({ auth: r.headers.authorization }))
    })
    await new Promise((res) => upstream.listen(0, '127.0.0.1', res))
    upstreamPort = upstream.address().port
  })

  after(async () => {
    await proxy?.stop()
    await new Promise((r) => upstream.close(r))
    await rm(dir, { recursive: true, force: true })
  })

  it('허용 호스트 → placeholder가 진짜 값으로 치환되어 업스트림 도달', async () => {
    const { placeholderByKey, injectionMap } = buildInjectionMap([
      { key: 'MY_TOKEN', realValue: 'REAL_SECRET_VALUE', allowedHosts: ['localhost'] },
    ])
    proxy = new InjectionProxy({ injectionMap, certManager: cm, upstreamCa: upCa })
    proxyPort = (await proxy.start(0)).port

    const ph = placeholderByKey.get('MY_TOKEN')
    const res = await requestThroughProxy({
      proxyPort, upstreamPort, caPem: cm.caCertPem,
      authHeader: `Bearer ${ph}`,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.auth, 'Bearer REAL_SECRET_VALUE')
  })

  it('비허용 호스트 → 403 차단(업스트림 미도달·진짜 값 유출 없음)', async () => {
    const { placeholderByKey, injectionMap } = buildInjectionMap([
      { key: 'MY_TOKEN', realValue: 'REAL_SECRET_VALUE', allowedHosts: ['api.other.com'] },
    ])
    proxy.updateMap(injectionMap)

    const ph = placeholderByKey.get('MY_TOKEN')
    const res = await requestThroughProxy({
      proxyPort, upstreamPort, caPem: cm.caCertPem,
      authHeader: `Bearer ${ph}`,
    })
    // localhost는 allowedHosts에 없음 → 프록시가 403으로 차단, 업스트림(echo)에 도달하지 않음
    assert.equal(res.status, 403)
    assert.equal(res.json.error, 'secret_host_not_allowed')
    assert.equal(res.json.secret, 'MY_TOKEN')
    assert.equal(res.json.host, 'localhost')
    assert.equal(res.json.auth, undefined) // 업스트림 echo 없음
    assert.ok(!JSON.stringify(res.json).includes('REAL_SECRET_VALUE'))
  })

  it('placeholder 없는 일반 요청 → 그대로 통과(차단 아님)', async () => {
    const { injectionMap } = buildInjectionMap([
      { key: 'MY_TOKEN', realValue: 'REAL_SECRET_VALUE', allowedHosts: ['api.other.com'] },
    ])
    proxy.updateMap(injectionMap)

    const res = await requestThroughProxy({
      proxyPort, upstreamPort, caPem: cm.caCertPem,
      authHeader: 'Bearer some-normal-token',
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.auth, 'Bearer some-normal-token')
  })
})
