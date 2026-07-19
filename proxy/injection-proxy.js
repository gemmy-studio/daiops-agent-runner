/**
 * 크레덴셜 주입 프록시 — 서버 본체 (Phase 1).
 *
 * 샌드박스의 모든 아웃바운드(bash curl·python·MCP)를 HTTP_PROXY/HTTPS_PROXY로 이 프록시에
 * 통과시킨다. 프록시는 요청 헤더/URL/바디에서 placeholder를 찾아, **그 placeholder의 allowed_hosts에
 * 목적지가 포함될 때만** 진짜 값으로 치환한 뒤 업스트림으로 전달한다. 허용되지 않으면 placeholder를
 * 그대로 보내 업스트림이 인증 실패 → 진짜 값은 임의 목적지로 새지 않는다.
 *
 * - plain http:// : absolute-form 요청을 그대로 파싱해 치환·전달.
 * - https:// : CONNECT를 MITM한다(cert-manager가 호스트별 인증서 발급, 샌드박스는 CA를 신뢰).
 *
 * 응답 본문은 치환하지 않는다(진짜 값을 응답에 넣지 않으므로). 의존성 0(node 내장만).
 */

import http from 'node:http'
import https from 'node:https'
import { substituteInText, substituteHeaders, PLACEHOLDER_PREFIX } from './injection-core.js'

/** hop-by-hop 헤더 — 프록시가 업스트림/클라이언트로 전달하지 않는다(RFC 7230 §6.1 + proxy-*). */
const HOP_BY_HOP = Object.freeze([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** host:port에서 host만(소문자). */
function hostOnly(hostHeader) {
  if (!hostHeader) return ''
  let h = String(hostHeader)
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']')).toLowerCase()
  const c = h.indexOf(':')
  return (c >= 0 ? h.slice(0, c) : h).toLowerCase()
}

export class InjectionProxy {
  /**
   * @param {{
   *   injectionMap: Map<string, {key:string, realValue:string, allowedHosts:string[]}>,
   *   certManager: import('./cert-manager.js').CertManager,
   *   upstreamCa?: string | string[],   // 업스트림 검증용 추가 CA (테스트/사설 CA)
   *   logger?: { info: Function, warn: Function, error: Function },
   * }} opts
   */
  constructor({ injectionMap, certManager, upstreamCa, logger }) {
    this.injectionMap = injectionMap ?? new Map()
    this.certManager = certManager
    this.upstreamCa = upstreamCa
    this.log = logger ?? { info() {}, warn() {}, error() {} }
    this.server = null
    this.mitm = null
  }

  /** 시크릿 변경 시 맵 교체(재기동 없이 다음 요청부터 반영). */
  updateMap(injectionMap) {
    this.injectionMap = injectionMap ?? new Map()
  }

  /** @param {number} port @param {string} [host] */
  async start(port, host = '127.0.0.1') {
    await this.certManager.init()

    // MITM용 https 서버 — CONNECT 소켓을 여기로 넘겨 TLS 종단 + 복호화된 요청 처리.
    this.mitm = https.createServer(
      {
        SNICallback: (servername, cb) => {
          this.certManager.getSecureContext(servername)
            .then((ctx) => cb(null, ctx))
            .catch((err) => cb(err))
        },
      },
      (creq, cres) => this._handleDecrypted(creq, cres, 'https'),
    )
    this.mitm.on('clientError', (_e, sock) => sock.destroy())

    this.server = http.createServer((req, res) => this._handleAbsolute(req, res))
    this.server.on('connect', (req, socket) => this._handleConnect(req, socket))
    this.server.on('clientError', (_e, sock) => sock.destroy())

    await new Promise((resolve) => this.server.listen(port, host, resolve))
    return this.server.address()
  }

  async stop() {
    await new Promise((r) => (this.server ? this.server.close(r) : r()))
    await new Promise((r) => (this.mitm ? this.mitm.close(r) : r()))
  }

  /** plain http:// (absolute-form) 요청 처리. */
  _handleAbsolute(req, res) {
    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400).end('bad request target')
      return
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end('unsupported scheme')
      return
    }
    this._collectBody(req, (bodyBuf) => {
      this._forward({
        scheme: 'http',
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
        bodyBuf,
        res,
      })
    })
  }

  /** CONNECT — 200 후 소켓을 MITM https 서버로 넘김. */
  _handleConnect(req, socket) {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.on('error', () => socket.destroy())
    this.mitm.emit('connection', socket)
  }

  /** MITM으로 복호화된 https 요청 처리. */
  _handleDecrypted(creq, cres, scheme) {
    const hostHeader = creq.headers.host || ''
    const host = hostOnly(hostHeader)
    const port = (hostHeader.match(/:(\d+)$/)?.[1]) || 443
    this._collectBody(creq, (bodyBuf) => {
      this._forward({
        scheme,
        host,
        port,
        path: creq.url,
        method: creq.method,
        headers: creq.headers,
        bodyBuf,
        res: cres,
      })
    })
  }

  _collectBody(req, done) {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', () => done(Buffer.concat(chunks)))
  }

  /** 치환 후 업스트림으로 전달하고 응답을 그대로 파이프. */
  _forward({ scheme, host, port, path, method, headers, bodyBuf, res }) {
    const dest = hostOnly(host)

    // 헤더 치환 (원본 복사 — hop-by-hop 헤더 제거)
    const cleaned = { ...headers }
    for (const h of HOP_BY_HOP) delete cleaned[h]
    const { headers: subHeaders } = substituteHeaders(cleaned, dest, this.injectionMap)

    // URL 치환 (쿼리파라미터에 placeholder가 있을 수 있음)
    const subPath = substituteInText(path, dest, this.injectionMap).text

    // 바디 치환 (placeholder가 있을 때만 — 일반/바이너리 바디는 건드리지 않음)
    let outBody = bodyBuf
    if (bodyBuf && bodyBuf.length && bodyBuf.includes(PLACEHOLDER_PREFIX)) {
      const r = substituteInText(bodyBuf.toString('utf-8'), dest, this.injectionMap)
      outBody = Buffer.from(r.text, 'utf-8')
    }
    if (outBody && outBody.length) {
      subHeaders['content-length'] = String(outBody.length)
    } else {
      delete subHeaders['content-length']
    }
    subHeaders.host = host

    const mod = scheme === 'https' ? https : http
    const opts = {
      host: dest,
      port: Number(port),
      path: subPath,
      method,
      headers: subHeaders,
    }
    if (scheme === 'https' && this.upstreamCa) opts.ca = this.upstreamCa

    const upstream = mod.request(opts, (ures) => {
      // hop-by-hop 응답 헤더 제거 — 특히 connection/keep-alive를 클라이언트로 전달하면
      // 소켓이 안 닫혀 idle 타임아웃까지 대기(요청당 지연). 프레이밍은 Node가 재적용.
      const resHeaders = { ...ures.headers }
      for (const h of HOP_BY_HOP) delete resHeaders[h]
      res.writeHead(ures.statusCode || 502, resHeaders)
      ures.pipe(res)
    })
    upstream.on('error', (err) => {
      this.log.warn('[injection-proxy] upstream 오류', { host: dest, error: err.message })
      if (!res.headersSent) res.writeHead(502)
      res.end('upstream error')
    })
    if (outBody && outBody.length) upstream.write(outBody)
    upstream.end()
  }
}
