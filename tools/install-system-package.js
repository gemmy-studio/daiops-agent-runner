/**
 * InstallSystemPackage — AI 팀원이 OS 꾸러미 이름만 청하면 러너가 감싸기 밖에서 공식 저장소 꾸러미를 깐다.
 * 기획: daiops 아카이브 1-doc-management/261127-plan-track-g-install-request.md(대표 「권장대로」 11-27, 보안 검토 12절).
 *
 * 감싼 셸은 시스템 폴더와 apt, dpkg 상태가 읽기 전용이라(0.41.4, 0.41.6) apt-get 을 못 쓴다. 이 도구가 유일한 설치 길이다.
 *  - 이름만 받는다. 옵션, 버전, 경로, URL, 셸 문자열은 받지 않는다(데비안 이름 꼴 검사)
 *  - 셸 없이 고정 인자, 새로 짠 환경 변수(절대 경로, PATH, DEBIAN_FRONTEND, LANG), cwd `/`, TMPDIR 은 감싼 셸이 못 쓰는 러너 상태 아래
 *  - 먼저 `-s` 로 본다. 이미 깔린 꾸러미를 올리거나(`Inst x [옛판]`) 지우면(`Remv`) 거절한다. `--no-upgrade` 는 의존성 올림을
 *    못 막기 때문이다(보안 검토 12절 물음 2). 실행은 `-s` 가 정한 꾸러미를 모두 `이름=판` 으로 적고 `--no-remove`
 *  - 새로 깔리면 안 되는 꾸러미(러너, 감싸기, init 계열)는 의존성으로 딸려 와도 거절
 *  - 받을 크기 상한
 *  - 설치 전 policy-rc.d 가 101(서비스 시작 금지)인지 확인
 *  - 한 번에 하나(dpkg 잠금)
 * 결재는 handler.js evaluatePolicy 가 먼저 본다(전권 직원도 승인 목록 밖이면 결재). 이 파일은 실행만 한다.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'

export const INSTALL_SYSTEM_PACKAGE_TOOL_NAME = 'InstallSystemPackage'

export const INSTALL_SYSTEM_PACKAGE_TOOL = Object.freeze({
  name: INSTALL_SYSTEM_PACKAGE_TOOL_NAME,
  description:
    'Install Debian/Ubuntu OS packages from the official repository (the shell cannot run apt-get; system folders are read-only). '
    + 'Give package names only, no options or versions. A package the manager has not approved before needs approval. '
    + 'Approved packages are reinstalled automatically when the workspace is rebuilt. '
    + 'For Python packages use pip install (goes to your home folder) or a venv; for Node use npx or a local npm install.',
  input_schema: {
    type: 'object',
    properties: {
      packages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Debian package names, e.g. ["ffmpeg"]' },
      reason: { type: 'string', description: 'One sentence: what the work needs this for (shown to the approver)' },
    },
    required: ['packages', 'reason'],
  },
})

/** 데비안 꾸러미 이름(Debian Policy 5.6.1): 소문자, 숫자, + - . 두 글자 이상, 영숫자로 시작 */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,62}$/
export const MAX_PACKAGES = 10
/** 받을 크기 상한(바이트) */
export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024

/**
 * 새로 깔리면 안 되는 꾸러미. 러너, 감싸기, 꾸러미 관리자, init 계열과 보안 모듈(보안 검토 12절 + 기획 2절).
 * 이미 깔린 것의 판 바뀜은 `-s` 의 올림 거절이 막는다. 여기는 「새로 들어오면 안 되는 것」만 맡는다
 */
const DENIED_PATTERNS = [
  /^bubblewrap$/, /^apt$/, /^apt-utils$/, /^dpkg$/, /^libc6$/, /^libc-bin$/, /^nodejs$/, /^python3(\.\d+)?(-minimal)?$/,
  /^bash$/, /^coreutils$/, /^openssl$/, /^login$/, /^passwd$/, /^sudo$/, /^util-linux$/,
  /^systemd/, /^init($|-)/, /^sysvinit/, /^libpam-/, /^snoopy$/, /^linux-image-/, /^apparmor/,
  // apt, dpkg 훅을 까는 꾸러미. 깔리면 그 뒤 모든 apt 실행 때 감싸기 밖 root 로 돈다. needrestart 는 도는 프로세스의
  // 환경 변수로 인터프리터를 띄워 root 상승 CVE(CVE-2024-48990 등)가 났고 감싼 셸 프로세스가 그 입력이 된다(보안 검토 12-7)
  /^needrestart$/, /^apt-listchanges$/, /^apt-listbugs$/, /^etckeeper$/, /^unattended-upgrades$/, /^debsums$/,
  /^apt-config-/, /^apticron/, /^molly-guard$/,
]
export const isDeniedPackage = (name) => DENIED_PATTERNS.some((re) => re.test(name))

/** @returns {{ ok: true, names: string[] } | { ok: false, error: string }} */
export function validatePackageNames(input) {
  const list = input?.packages
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'packages must be a non-empty array of package names' }
  if (list.length > MAX_PACKAGES) return { ok: false, error: `at most ${MAX_PACKAGES} packages per request` }
  const names = []
  for (const raw of list) {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (!PACKAGE_NAME.test(name)) return { ok: false, error: `'${String(raw).slice(0, 80)}' is not a package name (names only, no options, versions or paths)` }
    if (isDeniedPackage(name)) return { ok: false, error: `'${name}' cannot be installed on a workspace (it is part of the platform)` }
    if (!names.includes(name)) names.push(name)
  }
  return { ok: true, names }
}

/**
 * `apt-get -s install` 출력에서 깔림, 올림, 지움을 읽는다.
 *   Inst ffmpeg (7:5.1.6-0+deb12u1 Debian:12.8/stable [amd64])           새로 깔림
 *   Inst libc6 [2.36-9+deb12u7] (2.36-9+deb12u9 Debian-Security:12 [amd64]) 올림
 *   Remv foo [1.0]                                                         지움
 */
export function parseSimulation(stdout) {
  const installs = []
  const upgrades = []
  const removes = []
  for (const line of String(stdout).split('\n')) {
    let m = line.match(/^Inst (\S+) \[([^\]]+)\] \((\S+)/)
    if (m) { upgrades.push({ name: m[1], from: m[2], version: m[3] }); continue }
    m = line.match(/^Inst (\S+) \((\S+)/)
    if (m) { installs.push({ name: m[1].replace(/:\w+$/, ''), version: m[2] }); continue }
    m = line.match(/^Remv (\S+)/)
    if (m) removes.push(m[1])
  }
  return { installs, upgrades, removes }
}

/** `--print-uris` 출력의 크기 합. 줄 꼴: 'uri' 파일이름 크기 해시 */
export function sumDownloadBytes(stdout) {
  let total = 0
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^'[^']+' \S+ (\d+) /)
    if (m) total += Number(m[1])
  }
  return total
}

/** 감싸기 밖 apt 의 환경. 러너 환경 변수를 물려주지 않는다(보안 검토 12절 물음 1) */
export function aptEnv(tmpdir) {
  return {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    DEBIAN_FRONTEND: 'noninteractive',
    LANG: 'C.UTF-8',
    TMPDIR: tmpdir,
  }
}

const APT_GET = '/usr/bin/apt-get'
const DPKG_QUERY = '/usr/bin/dpkg-query'
const POLICY_RC_D = '/usr/sbin/policy-rc.d'
const APT_LISTS = '/var/lib/apt/lists'
/** 설치 뒤 바뀌면 안 되는 곳. 훅이 들어오면 다음 apt 실행 때 감싸기 밖 root 로 돈다(보안 검토 12-7). 거절 목록이 1차, 이것이 2차 */
export const HOOK_PATHS = ['/etc/apt/apt.conf.d', '/etc/dpkg/dpkg.cfg.d', '/etc/ld.so.preload']
/** 감싼 셸이 못 쓰는 러너 상태 아래(RUNNER_READONLY_DIRS). 설치 기록과 임시 폴더 */
const STATE_DIR = process.env.AGENT_RUNNER_STATE_DIR || '/workspace/.agent-runner'
export const SYSTEM_PACKAGES_FILE = () => path.join(STATE_DIR, 'system-packages.json')
const APT_TMP_ROOT = () => path.join(STATE_DIR, 'apt-tmp')
const TIMEOUT_MS = 300_000

/** @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
function defaultRun(file, args, { env, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { env, cwd: '/', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

let queue = Promise.resolve()
/** dpkg 잠금 때문에 한 번에 하나 */
function serialize(fn) {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

const tail = (s, n = 600) => String(s).trim().slice(-n)
const fail = (msg) => ({ content: `InstallSystemPackage: ${msg}`, is_error: true })

/** 훅 자리의 지문(파일 이름, 크기, 내용). 디렉터리는 한 단계만 본다(apt.conf.d, dpkg.cfg.d 는 평평하다) */
export function hookFingerprint(paths = HOOK_PATHS) {
  const parts = []
  for (const p of paths) {
    let entries
    try { entries = readdirSync(p).sort() } catch {
      try { parts.push(`${p}=${readFileSync(p, 'utf8')}`) } catch { parts.push(`${p}=<없음>`) }
      continue
    }
    for (const name of entries) {
      let body = ''
      try { body = readFileSync(path.join(p, name), 'utf8') } catch { body = '<읽지 못함>' }
      parts.push(`${p}/${name}=${body}`)
    }
  }
  return parts.join('\n')
}

/** 기록 파일에 더한다(정본은 앱 agent_config, 이것은 보조). 쓰기 실패는 설치 결과를 바꾸지 않는다 */
function recordInstalled(requested, installed) {
  try {
    const file = SYSTEM_PACKAGES_FILE()
    let list = []
    try { list = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 처음 */ }
    if (!Array.isArray(list)) list = []
    const at = new Date().toISOString()
    for (const name of requested) {
      const version = installed.find((p) => p.name === name)?.version ?? null
      list = list.filter((p) => p?.name !== name)
      list.push({ name, version, at })
    }
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(list, null, 2))
    renameSync(tmp, file)
  } catch { /* 보조 기록 */ }
}

/**
 * 설치 미리 보기(바꾸지 않음). 결재 카드와 실행이 같은 판정을 쓴다.
 * @returns {Promise<{ ok: true, installs: {name: string, version: string}[], downloadBytes: number } | { ok: false, error: string }>}
 */
export async function previewInstall(names, deps = {}) {
  const run = deps.run ?? defaultRun
  const tmpdir = deps.tmpdir ?? '/tmp'
  const env = aptEnv(tmpdir)
  const hasLists = deps.hasLists ?? (() => { try { return readdirSync(APT_LISTS).some((f) => f.endsWith('_Packages')) } catch { return false } })
  if (!hasLists()) {
    // 이미지가 목록을 지운다. 처음 한 번 받는다
    const up = await run(APT_GET, ['update', '-qq'], { env })
    if (up.code !== 0) return { ok: false, error: `package lists could not be fetched: ${tail(up.stderr || up.stdout, 300)}` }
  }
  const sim = await run(APT_GET, ['install', '-s', '--no-install-recommends', '--', ...names], { env })
  if (sim.code !== 0) return { ok: false, error: `apt could not resolve these packages: ${tail(sim.stdout + sim.stderr, 400)}` }
  const { installs, upgrades, removes } = parseSimulation(sim.stdout)
  if (upgrades.length > 0) {
    return { ok: false, error: `installing would upgrade packages the platform depends on (${upgrades.map((u) => u.name).slice(0, 8).join(', ')}); ask the platform team` }
  }
  if (removes.length > 0) return { ok: false, error: `installing would remove packages (${removes.slice(0, 8).join(', ')})` }
  const denied = installs.filter((p) => isDeniedPackage(p.name)).map((p) => p.name)
  if (denied.length > 0) return { ok: false, error: `these would come in as dependencies and are not allowed: ${denied.join(', ')}` }
  if (installs.length === 0) return { ok: true, installs: [], downloadBytes: 0 }
  const uris = await run(APT_GET, ['install', '--print-uris', '-qq', '--no-install-recommends', '--', ...names], { env })
  // 크기를 못 재면 거절한다. 0 바이트로 보면 상한을 그냥 지난다(보안 검토 12-7 권장)
  if (uris.code !== 0) return { ok: false, error: `download size could not be measured: ${tail(uris.stdout + uris.stderr, 300)}` }
  const downloadBytes = sumDownloadBytes(uris.stdout)
  if (downloadBytes > MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: `download is ${Math.round(downloadBytes / 1024 / 1024)} MB, over the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB limit` }
  }
  return { ok: true, installs, downloadBytes }
}

/**
 * 결재 카드용 미리 보기(러너 엔드포인트). 같은 이름 검사, 설치 줄 안에서 돈다. 미리 보기는 승인이 아니다(보안 검토 12-7 물음 4)
 * @returns {Promise<{ ok: true, installs: {name: string, version: string}[], downloadBytes: number } | { ok: false, error: string }>}
 */
export function previewInstallRequest(input, deps = {}) {
  const v = validatePackageNames(input)
  if (!v.ok) return Promise.resolve({ ok: false, error: v.error })
  return serialize(async () => {
    let tmpdir = deps.tmpdir
    if (!tmpdir) {
      mkdirSync(APT_TMP_ROOT(), { recursive: true })
      tmpdir = mkdtempSync(path.join(APT_TMP_ROOT(), 'preview-'))
    }
    try {
      return await previewInstall(v.names, { ...deps, tmpdir })
    } finally {
      if (!deps.tmpdir) { try { rmSync(tmpdir, { recursive: true, force: true }) } catch { /* 같음 */ } }
    }
  })
}

/**
 * @param {{ packages?: unknown, reason?: unknown }} input
 * @param {object} [_ctx]
 * @param {{ run?: typeof defaultRun, hasLists?: () => boolean, policyRcD?: () => Promise<number> }} [deps] 시험용
 */
export async function runInstallSystemPackage(input, _ctx = {}, deps = {}) {
  const v = validatePackageNames(input)
  if (!v.ok) return fail(v.error)
  return serialize(async () => {
    const run = deps.run ?? defaultRun
    let tmpdir = deps.tmpdir
    if (!tmpdir) {
      mkdirSync(APT_TMP_ROOT(), { recursive: true })
      tmpdir = mkdtempSync(path.join(APT_TMP_ROOT(), 'run-'))
    }
    try {
      // 서비스를 띄우지 않게(policy-rc.d 101). 없거나 다르면 깔지 않는다
      const rc = deps.policyRcD ? await deps.policyRcD() : (existsSync(POLICY_RC_D) ? (await run(POLICY_RC_D, ['x', 'start'], { env: aptEnv(tmpdir), timeoutMs: 10_000 })).code : -1)
      if (rc !== 101) return fail('this workspace image cannot install packages safely (policy-rc.d missing); ask the platform team')
      const preview = await previewInstall(v.names, { ...deps, run, tmpdir })
      if (!preview.ok) return fail(preview.error)
      if (preview.installs.length === 0) {
        recordInstalled(v.names, await queryInstalled(run, tmpdir, v.names))
        return { content: `Already installed: ${v.names.join(', ')}` }
      }
      const pinned = preview.installs.map((p) => `${p.name}=${p.version}`)
      const fingerprint = deps.hookFingerprint ?? hookFingerprint
      const before = fingerprint()
      const res = await run(APT_GET, ['install', '-y', '-qq', '--no-install-recommends', '--no-remove', '--no-upgrade', '--', ...pinned], { env: aptEnv(tmpdir) })
      if (fingerprint() !== before) {
        // 거절 목록을 지나 훅을 깐 꾸러미. 이번에 깐 것을 지운다(정확히 무엇이 훅을 넣었는지는 따지지 않는다)
        await run(APT_GET, ['purge', '-y', '-qq', '--', ...preview.installs.map((p) => p.name)], { env: aptEnv(tmpdir) })
        const after = fingerprint()
        return fail(`these packages change how apt or dpkg runs and were removed${after !== before ? ' (removal was incomplete; the platform team has been notified)' : ''}`)
      }
      if (res.code !== 0) return fail(`apt-get failed (exit ${res.code}): ${tail(res.stdout + res.stderr)}`)
      const installed = await queryInstalled(run, tmpdir, v.names)
      recordInstalled(v.names, installed)
      const deps_ = preview.installs.length - v.names.length
      return {
        content: `Installed ${installed.map((p) => `${p.name} ${p.version}`).join(', ')}`
          + (deps_ > 0 ? ` (+${deps_} dependencies)` : '')
          + `. It will be reinstalled if this workspace is rebuilt.`,
      }
    } finally {
      if (!deps.tmpdir) { try { rmSync(tmpdir, { recursive: true, force: true }) } catch { /* 다음 회차가 덮어쓴다 */ } }
    }
  })
}

async function queryInstalled(run, tmpdir, names) {
  const q = await run(DPKG_QUERY, ['-W', '-f', '${Package}\t${Version}\n', '--', ...names], { env: aptEnv(tmpdir), timeoutMs: 10_000 })
  return String(q.stdout).split('\n').filter(Boolean).map((l) => { const [name, version] = l.split('\t'); return { name, version } })
}
