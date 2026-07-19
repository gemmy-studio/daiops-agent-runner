/**
 * 크레덴셜 주입 프록시 — MITM 인증서 매니저 (Phase 1, openssl CLI 기반·의존성 0).
 *
 * HTTPS(CONNECT) MITM을 위해 부팅 시 자체 CA를 만들고, 목적지 호스트별 leaf 인증서를
 * CA로 서명해 발급한다(캐시). 러너는 이 CA를 NODE_EXTRA_CA_CERTS로 신뢰하고, 샌드박스
 * 셸(curl/python)도 같은 CA를 신뢰하도록 buildToolEnv가 env를 주입한다.
 *
 * 의존성 0 정책(licensing): node-forge 등 라이브러리 대신 샌드박스에 있는 openssl CLI를 쓴다.
 * EC(P-256) 키로 민팅을 빠르게, execFile(arg 배열)로 셸 인젝션 차단, 호스트는 발급 전 검증.
 *
 * ⚠️ CA 개인키는 프록시 프로세스만 접근(0600, 별도 유저 하드닝은 후속). 이 CA는 *샌드박스 내부
 * 전용*이며 외부 신뢰 체인에 들어가지 않는다.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, chmod, mkdir } from 'node:fs/promises'
import { createSecureContext } from 'node:tls'
import path from 'node:path'
import os from 'node:os'

const execFileP = promisify(execFile)

/** 호스트명 검증 — openssl CN/SAN에 넣기 전. DNS 라벨 문자만 허용(injection·와일드카드 차단). */
export function isValidHostname(host) {
  return (
    typeof host === 'string' &&
    host.length > 0 &&
    host.length <= 253 &&
    /^[a-zA-Z0-9.-]+$/.test(host) &&
    !host.includes('..')
  )
}

export class CertManager {
  /** @param {{ baseDir?: string }} [opts] */
  constructor(opts = {}) {
    this.baseDir = opts.baseDir ?? null
    this.caKeyPath = null
    this.caCertPath = null
    this.caCertPem = null
    this.leafKeyPath = null
    this.leafKeyPem = null
    /** @type {Map<string, import('node:tls').SecureContext>} */
    this.contextCache = new Map()
    /** @type {Map<string, Promise<import('node:tls').SecureContext>>} */
    this.inflight = new Map()
    this._initP = null
  }

  /** CA + 공유 leaf 키를 1회 생성(idempotent). */
  async init() {
    if (this._initP) return this._initP
    this._initP = (async () => {
      const dir = this.baseDir ?? (await mkdtemp(path.join(os.tmpdir(), 'daiops-proxy-')))
      await mkdir(dir, { recursive: true })
      this.caKeyPath = path.join(dir, 'ca.key')
      this.caCertPath = path.join(dir, 'ca.crt')
      this.leafKeyPath = path.join(dir, 'leaf.key')
      this._dir = dir

      // CA 개인키 (EC P-256)
      await execFileP('openssl', ['genpkey', '-algorithm', 'EC',
        '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', this.caKeyPath])
      await chmod(this.caKeyPath, 0o600)
      // 자체 서명 CA 인증서
      await execFileP('openssl', ['req', '-x509', '-new', '-key', this.caKeyPath,
        '-days', '3650', '-subj', '/CN=daiops-proxy-ca',
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-out', this.caCertPath])
      await chmod(this.caCertPath, 0o644)
      this.caCertPem = await readFile(this.caCertPath, 'utf-8')

      // 공유 leaf 키(모든 호스트가 재사용 — 민팅은 인증서만)
      await execFileP('openssl', ['genpkey', '-algorithm', 'EC',
        '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', this.leafKeyPath])
      await chmod(this.leafKeyPath, 0o600)
      this.leafKeyPem = await readFile(this.leafKeyPath, 'utf-8')
    })()
    return this._initP
  }

  /**
   * 호스트용 SecureContext 반환(캐시 + 동시요청 dedup).
   * @param {string} host
   * @returns {Promise<import('node:tls').SecureContext>}
   */
  async getSecureContext(host) {
    if (!isValidHostname(host)) throw new Error(`invalid host for cert: ${host}`)
    const cached = this.contextCache.get(host)
    if (cached) return cached
    const pending = this.inflight.get(host)
    if (pending) return pending

    const p = this._mint(host)
      .then((ctx) => {
        this.contextCache.set(host, ctx)
        this.inflight.delete(host)
        return ctx
      })
      .catch((err) => {
        this.inflight.delete(host)
        throw err
      })
    this.inflight.set(host, p)
    return p
  }

  /** @param {string} host */
  async _mint(host) {
    await this.init()
    const csrPath = path.join(this._dir, `${host}.csr`)
    const certPath = path.join(this._dir, `${host}.crt`)
    const extPath = path.join(this._dir, `${host}.ext`)

    await writeFile(extPath,
      'basicConstraints=CA:FALSE\n' +
      'keyUsage=digitalSignature,keyEncipherment\n' +
      'extendedKeyUsage=serverAuth\n' +
      `subjectAltName=DNS:${host}\n`)

    await execFileP('openssl', ['req', '-new', '-key', this.leafKeyPath,
      '-subj', `/CN=${host}`, '-out', csrPath])
    await execFileP('openssl', ['x509', '-req', '-in', csrPath,
      '-CA', this.caCertPath, '-CAkey', this.caKeyPath, '-CAcreateserial',
      '-days', '825', '-extfile', extPath, '-out', certPath])

    const certPem = await readFile(certPath, 'utf-8')
    return createSecureContext({ key: this.leafKeyPem, cert: certPem })
  }
}
