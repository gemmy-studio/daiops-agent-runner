/**
 * 빌트인 도구 공통 헬퍼 — 경로 해석·바이너리 감지·쓰기 안전 가드·라인 포맷팅.
 *
 *   - DAIOPS_WRITE_SAFE_ROOT env로 sandbox 경계 옵트인 강화.
 *   - 시스템 디렉토리 보호 (_is_write_denied).
 *   - 바이너리 감지: 확장자 우선 + 내용 sniff(>30% 비프린터블) 보조.
 *   - 라인 prefix: `'      N|content'` (6자리 우측 정렬 + '|').
 *
 * daiops 적용:
 *   - DEFAULT_CWD = '/workspace' (handler.js와 동일).
 *   - sandbox(Daytona)가 1차 격리, 본 가드는 2차 방어.
 */

import { promises as fs, existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const MAX_LINE_LENGTH = 2000
export const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
export const DEFAULT_READ_LIMIT = 500
export const MAX_READ_LIMIT = 2000

/**
 * agent의 Bash/도구 자식 프로세스에 넘길 env에서 제거할 내부 인프라 시크릿.
 * 이 값들은 agent-runner 본체(turn-manager의 outbound LLM/MCP fetch)만 사용하며,
 * LLM이 셸에서 읽으면 프롬프트 인젝션으로 유출돼 워크스페이스 사칭에 악용될 수 있다.
 * 사용자 연동 시크릿은 BASH_ENV(/workspace/.integrations.env)로 의도적 주입이므로 건드리지 않는다.
 */
const TOOL_ENV_DENYLIST = Object.freeze(['AGENT_RUNNER_TOKEN', 'LLM_PROXY_URL'])

/**
 * 내부 시크릿을 제거한 자식 프로세스 env를 구성한다.
 * agent-runner의 process.env는 그대로 두고, *스폰되는 셸*에만 denylist를 적용한다.
 * @param {Record<string,string|undefined>} [extra] 명시적 추가/덮어쓰기 env
 * @returns {Record<string,string>}
 */
export function buildToolEnv(extra = {}) {
  /** @type {Record<string,string>} */
  const base = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (TOOL_ENV_DENYLIST.includes(k) || v === undefined) continue
    base[k] = v
  }
  for (const [k, v] of Object.entries(extra)) {
    // extra(세션 secret 등 명시 주입)에도 denylist를 적용한다. Phase B 격리에서 세션 secret이
    // 자식 env로 흐르므로, 내부 인프라 시크릿(AGENT_RUNNER_TOKEN/LLM_PROXY_URL)이 secret 경유로
    // 우회 주입되는 것을 막는 심층 방어 (1차는 request-secret.isReservedKey 거부).
    if (TOOL_ENV_DENYLIST.includes(k) || v === undefined) continue
    base[k] = v
  }
  return base
}

/** 절대 deny되는 쓰기 prefix — 시스템 디렉토리 보호. */
const WRITE_DENIED_PREFIXES = Object.freeze([
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
  '/boot', '/proc', '/sys', '/dev', '/var/lib', '/var/run',
])

/** 정확히 일치하면 deny되는 경로. */
const WRITE_DENIED_EXACT = Object.freeze(new Set([
  '/', '/root',
]))

/** 바이너리로 단정하는 확장자 (텍스트 sniff 생략하고 즉시 거부). */
const BINARY_EXTENSIONS = Object.freeze(new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.wmv', '.mkv', '.webm',
  '.pyc', '.class', '.o', '.a',
]))

/** 이미지 확장자 (별도 분기 가능). */
export const IMAGE_EXTENSIONS = Object.freeze(new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
]))

/**
 * 경로 해석:
 *  - `~` / `~/`은 HOME으로 확장 (process.env.HOME 또는 os.homedir).
 *  - 절대 경로면 그대로, 상대 경로면 cwd 기준.
 *  - cwd 미지정 시 DEFAULT_CWD('/workspace') 사용 — handler.js의 DEFAULT_CWD와 동일.
 *
 * @param {string} input — 사용자 입력 경로
 * @param {string=} cwd — 작업 디렉토리 (기본 '/workspace')
 * @returns {string} 절대 경로
 */
export function resolvePath(input, cwd) {
  if (!input || typeof input !== 'string') return input
  let p = input
  if (p === '~' || p.startsWith('~/')) {
    const home = process.env.HOME ?? os.homedir() ?? ''
    p = home + p.slice(1)
  }
  if (path.isAbsolute(p)) return path.normalize(p)
  return path.resolve(cwd ?? '/workspace', p)
}

/**
 * SEC-T12 #6: 심볼릭 링크를 해석한 실경로 반환. deny-prefix·safe-root 검사를 *심링크 해석 후*
 * 경로로 수행하기 위함 — `/workspace/link → /etc` 같은 심링크로 시스템 디렉토리 보호·safe-root를
 * 우회하는 것을 차단(hermes `_is_write_denied`가 os.path.realpath로 해석하는 패턴 동형).
 * 대상이 아직 없으면(신규 파일 쓰기) 존재하는 최근접 상위를 realpath 후 나머지 tail을 재결합.
 *
 * @param {string} absPath
 * @returns {string}
 */
function realpathResolve(absPath) {
  const normalized = path.normalize(absPath)
  try {
    return realpathSync(normalized)
  } catch {
    // 존재하지 않는 경로 — 존재하는 최근접 상위를 해석한 뒤 비존재 tail을 재결합한다.
    let dir = path.dirname(normalized)
    const tailParts = [path.basename(normalized)]
    while (dir && dir !== path.dirname(dir)) {
      try {
        const realDir = realpathSync(dir)
        return path.join(realDir, ...tailParts.reverse())
      } catch {
        tailParts.push(path.basename(dir))
        dir = path.dirname(dir)
      }
    }
    return normalized
  }
}

/**
 * 쓰기 deny 여부.
 *  - 심링크 해석(realpathResolve) 후 WRITE_DENIED_EXACT / WRITE_DENIED_PREFIXES 1차 검사.
 *  - DAIOPS_WRITE_SAFE_ROOT 설정 시 그 트리 밖은 모두 deny (옵트인 sandbox 강화, 심링크 탈출 포함).
 *
 * @param {string} absPath
 * @returns {{denied: boolean, reason?: string}}
 */
export function isWriteDenied(absPath) {
  const resolved = realpathResolve(absPath)
  if (WRITE_DENIED_EXACT.has(resolved)) {
    return { denied: true, reason: `system path '${resolved}'` }
  }
  for (const prefix of WRITE_DENIED_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + path.sep)) {
      return { denied: true, reason: `under denied prefix '${prefix}'` }
    }
  }
  const safeRoot = process.env.DAIOPS_WRITE_SAFE_ROOT
  if (safeRoot) {
    const root = path.resolve(safeRoot)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { denied: true, reason: `outside DAIOPS_WRITE_SAFE_ROOT '${root}'` }
    }
  }
  return { denied: false }
}

/**
 * 확장자 기반 바이너리 여부 (fast path).
 *
 * @param {string} filePath
 */
export function isBinaryByExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

/**
 * 내용 sniff: 처음 4096바이트 중 null byte 존재 또는 비프린터블 비율 >30%.
 * 텍스트는 거의 절대 \0를 포함하지 않으므로 null이 강한 신호.
 *
 * @param {Buffer} buf
 */
export function isBinaryByContent(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 4096))
  let nonPrintable = 0
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]
    if (b === 0) return true
    // 프린터블이 아님: ASCII < 32 except \n(10), \r(13), \t(9)
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) nonPrintable++
  }
  if (sample.length === 0) return false
  return (nonPrintable / sample.length) > 0.30
}

/**
 * 라인 번호 prefix(`'      N|content'`, 6자리 우측 정렬 + '|') + 긴 라인 truncate.
 *
 * @param {string[]} lines
 * @param {number} startLineOneBased — 첫 번째 라인의 1-based 번호
 * @returns {string}
 */
export function formatNumberedLines(lines, startLineOneBased) {
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    if (line.length > MAX_LINE_LENGTH) {
      line = line.slice(0, MAX_LINE_LENGTH) + '… [truncated]'
    }
    out.push(`${String(startLineOneBased + i).padStart(6)}|${line}`)
  }
  return out.join('\n')
}

/** 안전한 stat — 실패 시 null. */
export async function safeStat(p) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

/**
 * ctx.cwd 기본값 산출.
 *   - ctx.cwd 주어지면 그대로 사용 (production: handler.js가 params.context_dir 전달).
 *   - 없으면 sandbox 디폴트 '/workspace'. 단, 해당 경로가 부재한 환경(테스트·로컬)에서는
 *     process.cwd()로 폴백 — 테스트 호환성.
 */
export function resolveCwd(ctx) {
  if (ctx?.cwd) return ctx.cwd
  if (existsSync('/workspace')) return '/workspace'
  return process.cwd()
}
