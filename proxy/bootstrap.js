/**
 * 크레덴셜 주입 프록시 — 러너 부팅 배선 (Phase 1).
 *
 * 부팅/시크릿 변경 시: cloud materialize에서 진짜 값+allowed_hosts를 받아 →
 * placeholder 맵을 만들고 → 프록시를 띄우고 → `.integrations.env`에는 **placeholder만** 쓴다.
 * 진짜 값은 프록시 프로세스 메모리(injectionMap)에만 존재하고 샌드박스 파일/셸 env엔 없다.
 *
 * server.js가 부팅/refresh 시 호출한다(상시 활성). 순수 로직은 단위 테스트,
 * 실제 부팅 통합은 라이브 샌드박스 검증.
 */

import { writeFile, chmod } from 'node:fs/promises'
import { buildInjectionMap } from './injection-core.js'
import { InjectionProxy } from './injection-proxy.js'
import { CertManager } from './cert-manager.js'

const MATERIALIZE_PATH = '/api/internal/secrets/materialize'

/** POSIX single-quote 이스케이프 (harness-bundler shellSingleQuote 동형). */
export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/**
 * placeholder 맵으로 `.integrations.env` 내용을 렌더 (export KEY='placeholder').
 * 진짜 값이 아니라 placeholder이므로 파일이 읽혀도 안전.
 * @param {Map<string,string>} placeholderByKey
 * @returns {string}
 */
export function renderIntegrationsEnv(placeholderByKey) {
  const lines = ['# DAIOps env (auto-generated — placeholders only, real values via injection proxy)']
  for (const [key, placeholder] of placeholderByKey) {
    lines.push(`export ${key}=${shellSingleQuote(placeholder)}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * cloud materialize에서 복호화된 시크릿을 가져온다.
 * @param {{ proxyOrigin: string, workspaceId: string, token: string, fetchFn?: typeof fetch }} opts
 * @returns {Promise<Array<{key:string, value:string, allowedHosts:string[]}>>}
 */
export async function fetchMaterializedSecrets({ proxyOrigin, workspaceId, token, fetchFn }) {
  const doFetch = fetchFn ?? globalThis.fetch
  const url = proxyOrigin.replace(/\/+$/, '') + MATERIALIZE_PATH
  const res = await doFetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'x-workspace-id': workspaceId,
    },
  })
  if (!res.ok) {
    throw new Error(`materialize failed: HTTP ${res.status}`)
  }
  const json = await res.json()
  const secrets = json?.data?.secrets
  return Array.isArray(secrets) ? secrets : []
}

/**
 * 시크릿으로 주입 프록시를 기동한다.
 * @param {{
 *   secrets: Array<{key:string, value:string, allowedHosts:string[]}>,
 *   proxyPort?: number, host?: string,
 *   certManager?: import('./cert-manager.js').CertManager,
 *   logger?: object,
 *   observer?: { record: (host: string, opts?: { blocked?: boolean }) => void },
 * }} opts
 * @returns {Promise<{ proxy: InjectionProxy, injectionMap: Map, placeholderByKey: Map, proxyUrl: string, caCertPath: string }>}
 */
export async function startInjectionBroker({ secrets, proxyPort = 0, host = '127.0.0.1', certManager, logger, observer }) {
  const cm = certManager ?? new CertManager()
  await cm.init()

  // materialize 결과 → placeholder 맵 (value → realValue로 정규화)
  const normalized = (secrets ?? []).map((s) => ({
    key: s.key,
    realValue: s.value,
    allowedHosts: Array.isArray(s.allowedHosts) ? s.allowedHosts : [],
  }))
  const { placeholderByKey, injectionMap } = buildInjectionMap(normalized)

  // observer는 egress 관측기(A-3 1단계). 미전달이면 관측 없이 동작(테스트·로컬 dev).
  const proxy = new InjectionProxy({ injectionMap, certManager: cm, logger, observer })
  const addr = await proxy.start(proxyPort, host)
  const proxyUrl = `http://${host}:${addr.port}`

  return { proxy, injectionMap, placeholderByKey, proxyUrl, caCertPath: cm.caCertPath }
}

/**
 * placeholder .integrations.env 파일을 쓴다(0600).
 * @param {string} filePath
 * @param {Map<string,string>} placeholderByKey
 */
export async function writePlaceholderEnvFile(filePath, placeholderByKey) {
  await writeFile(filePath, renderIntegrationsEnv(placeholderByKey), 'utf-8')
  await chmod(filePath, 0o600)
}
