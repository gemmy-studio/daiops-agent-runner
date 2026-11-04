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

  /**
   * 관측기 스텁 — 치환된 키가 실제로 원장으로 흘러가는지 확인한다. 종전에는 치환 엔진이 반환하던
   * 키 목록을 프록시가 버려서 "어떤 시크릿을 썼는지"가 어디에도 남지 않았다.
   */
  const observed = { hosts: [], secretUses: [] }
  const observer = {
    record: (host, opts) => observed.hosts.push({ host, ...opts }),
    recordSecretUse: (key, host) => observed.secretUses.push({ key, host }),
  }

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
    proxy = new InjectionProxy({ injectionMap, certManager: cm, upstreamCa: upCa, observer })
    proxyPort = (await proxy.start(0)).port

    const ph = placeholderByKey.get('MY_TOKEN')
    const res = await requestThroughProxy({
      proxyPort, upstreamPort, caPem: cm.caCertPem,
      authHeader: `Bearer ${ph}`,
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.auth, 'Bearer REAL_SECRET_VALUE')
    // 사용 원장 — 키 이름과 목적지만(값 없음)
    assert.deepEqual(observed.secretUses, [{ key: 'MY_TOKEN', host: 'localhost' }])
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
    // 차단된 요청은 "사용"이 아니다 — 실값이 나가지 않았으므로 원장에 남기지 않는다.
    assert.deepEqual(observed.secretUses, [{ key: 'MY_TOKEN', host: 'localhost' }])
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

/**
 * 프록시를 통해 CONNECT MITM으로 WebSocket 업그레이드를 보낸다. 101 이면 `ping` 을 보내 업스트림 echo 를 받는다.
 * 응답 머리(상태 · 헤더)와 101 뒤에 받은 바이트를 돌려준다.
 */
function upgradeThroughProxy({ proxyPort, upstreamPort, caPem, path: reqPath, authHeader }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method: 'CONNECT',
      path: `localhost:${upstreamPort}`,
    })
    req.on('error', reject)
    req.on('connect', (_res, socket) => {
      const t = tls.connect({ socket, servername: 'localhost', ca: caPem }, () => {
        t.write(
          `GET ${reqPath} HTTP/1.1\r\nHost: localhost:${upstreamPort}\r\n` +
          (authHeader ? `Authorization: ${authHeader}\r\n` : '') +
          'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        )
      })
      let buf = ''
      let headText = null
      const finish = () => {
        const text = headText ?? buf
        const status = Number(text.match(/^HTTP\/\d\.\d (\d+)/)?.[1] ?? 0)
        const headers = {}
        for (const line of text.split('\r\n').slice(1)) {
          const i = line.indexOf(':')
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
        }
        const after = headText ? buf.slice(headText.length) : buf.slice(buf.indexOf('\r\n\r\n') + 4)
        t.destroy()
        resolve({ status, headers, after })
      }
      t.on('data', (d) => {
        buf += d
        if (headText === null && buf.includes('\r\n\r\n')) {
          headText = buf.slice(0, buf.indexOf('\r\n\r\n') + 4)
          if (/^HTTP\/\d\.\d 101/.test(headText)) t.write('ping')
        }
        if (headText && /^HTTP\/\d\.\d 101/.test(headText) && buf.slice(headText.length).includes('echo:ping')) finish()
      })
      t.on('end', finish)
      t.on('error', reject)
    })
    req.end()
  })
}

describe('InjectionProxy — WebSocket 업그레이드(wss://)', () => {
  let dir, cm, upstream, upstreamPort, proxy, proxyPort, upCa
  const seen = []

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'proxy-ws-test-'))
    cm = new CertManager({ baseDir: dir })
    await cm.init()
    const { key, cert } = await makeSelfSigned(dir)
    upCa = cert
    upstream = https.createServer({ key, cert }, (_r, s) => {
      // 업그레이드 없이 온 요청은 404 — 종전 프록시가 upgrade 를 지워 일반 GET 으로 보내던 것과 같은 결과를 낸다
      s.writeHead(404, { 'content-type': 'text/plain' })
      s.end('not a websocket')
    })
    upstream.on('upgrade', (r, socket) => {
      seen.push({ url: r.url, auth: r.headers.authorization, upgrade: r.headers.upgrade })
      if (r.url.startsWith('/nope')) {
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nnope')
        return
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `X-Seen-Url: ${r.url}\r\n\r\n`,
      )
      socket.on('data', (d) => socket.write(`echo:${d}`))
    })
    await new Promise((res) => upstream.listen(0, '127.0.0.1', res))
    upstreamPort = upstream.address().port
  })

  after(async () => {
    await proxy?.stop()
    upstream.closeAllConnections?.()
    await new Promise((r) => upstream.close(r))
    await rm(dir, { recursive: true, force: true })
  })

  it('허용 호스트 → 경로 쿼리 · 헤더의 placeholder 를 치환하고 101 뒤 양방향으로 잇는다', async () => {
    const { placeholderByKey, injectionMap } = buildInjectionMap([
      { key: 'GEMINI_API_KEY', realValue: 'REAL+KEY/1', allowedHosts: ['localhost'] },
    ])
    proxy = new InjectionProxy({ injectionMap, certManager: cm, upstreamCa: upCa })
    proxyPort = (await proxy.start(0)).port

    const ph = placeholderByKey.get('GEMINI_API_KEY')
    const res = await upgradeThroughProxy({
      proxyPort, upstreamPort, caPem: cm.caCertPem,
      path: `/ws/live?key=${ph}`, authHeader: `Bearer ${ph}`,
    })
    assert.equal(res.status, 101)
    assert.equal(res.headers.upgrade, 'websocket')
    assert.ok(res.after.includes('echo:ping'))
    const last = seen.at(-1)
    assert.equal(last.upgrade, 'websocket')
    assert.equal(last.auth, 'Bearer REAL+KEY/1')
    // URL 에 들어가는 값은 percent-encoding 한다(`+` 가 공백으로 읽히지 않게)
    assert.equal(last.url, `/ws/live?key=${encodeURIComponent('REAL+KEY/1')}`)
  })

  it('비허용 호스트 → 403 차단(업스트림 미도달 · 진짜 값 유출 없음)', async () => {
    const { placeholderByKey, injectionMap } = buildInjectionMap([
      { key: 'GEMINI_API_KEY', realValue: 'REAL+KEY/1', allowedHosts: ['api.other.com'] },
    ])
    proxy.updateMap(injectionMap)
    const before = seen.length

    const ph = placeholderByKey.get('GEMINI_API_KEY')
    const res = await upgradeThroughProxy({
      proxyPort, upstreamPort, caPem: cm.caCertPem, path: `/ws/live?key=${ph}`,
    })
    assert.equal(res.status, 403)
    const json = JSON.parse(res.after)
    assert.equal(json.error, 'secret_host_not_allowed')
    assert.equal(json.secret, 'GEMINI_API_KEY')
    assert.ok(!res.after.includes('REAL+KEY'))
    assert.equal(seen.length, before)
  })

  it('업스트림이 업그레이드를 거절하면 그 응답을 그대로 돌려준다', async () => {
    const { injectionMap } = buildInjectionMap([])
    proxy.updateMap(injectionMap)

    const res = await upgradeThroughProxy({
      proxyPort, upstreamPort, caPem: cm.caCertPem, path: '/nope',
    })
    assert.equal(res.status, 404)
    assert.equal(res.after, 'nope')
  })
})
