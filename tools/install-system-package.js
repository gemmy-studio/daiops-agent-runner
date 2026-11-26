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
 * 결재는 handler.js evaluatePolicy 가 먼저 본다. 설치와 제거 모두 매번 결재다(대표 11-27 「매번 승인을 하자 … 제거도 동일해」).
 * 이 파일은 실행만 한다.
 *
 * RemoveSystemPackage(0.43.0): 이 길로 깐 꾸러미만 지운다. 기본 이미지에 든 꾸러미(이미지가 구울 때 적은 목록)는 지우지 않고,
 * 목록이 없으면 지우지 않는다. 지울 때 다른 꾸러미가 딸려 지워지면 거절한다(그것에 기대는 꾸러미가 있다는 뜻).
 * 승인 목록에 없는 이름은 handler.js 가 결재 전에 막는다.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'

export const INSTALL_SYSTEM_PACKAGE_TOOL_NAME = 'InstallSystemPackage'

export const INSTALL_SYSTEM_PACKAGE_TOOL = Object.freeze({
  name: INSTALL_SYSTEM_PACKAGE_TOOL_NAME,
  description:
    'Install Debian/Ubuntu OS packages from the official repository (the shell cannot run apt-get; system folders are read-only). '
    + 'Give package names only, no options or versions. Every install request needs approval. '
    + 'Installed packages are reinstalled automatically when the workspace is rebuilt. '
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

export const REMOVE_SYSTEM_PACKAGE_TOOL_NAME = 'RemoveSystemPackage'

export const REMOVE_SYSTEM_PACKAGE_TOOL = Object.freeze({
  name: REMOVE_SYSTEM_PACKAGE_TOOL_NAME,
  description:
    'Remove OS packages that were installed with InstallSystemPackage. Packages that came with the workspace cannot be removed. '
    + 'Every removal request needs approval. Removed packages are not reinstalled when the workspace is rebuilt.',
  input_schema: {
    type: 'object',
    properties: {
      packages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Debian package names, e.g. ["ffmpeg"]' },
      reason: { type: 'string', description: 'One sentence: why it is no longer needed (shown to the approver)' },
    },
    required: ['packages', 'reason'],
  },
})

/**
 * 결과 끝 줄의 표지. 앱이 이 줄로 승인 목록을 고친다(`installed=` 는 이번에 새로 깐 이름만, `removed=` 는 뺄 이름).
 * 실패(is_error)에는 붙지 않는다. CONTRACT.md 「설치 요청 결과」
 */
const SYSTEM_PACKAGES_MARKER = '[system-packages]'

/** 데비안 꾸러미 이름(Debian Policy 5.6.1): 소문자, 숫자, + - . 두 글자 이상, 영숫자로 시작 */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,62}$/
const MAX_PACKAGES = 10
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
    m = line.match(/^(?:Remv|Purg) (\S+)/)
    if (m) removes.push(m[1].replace(/:\w+$/, ''))
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
/** 저장소가 느리거나 503 일 때(snapshot.debian.org 실사례, 문서 관리 조사 11-27 덧붙임) 받기를 다시 한다. 고정 인자라 입력과 무관 */
const APT_RETRIES = ['-o', 'Acquire::Retries=3']
const DPKG_QUERY = '/usr/bin/dpkg-query'
const POLICY_RC_D = '/usr/sbin/policy-rc.d'
const APT_LISTS = '/var/lib/apt/lists'
/**
 * 설치 뒤 바뀌면 안 되는 곳. 훅이 들어오면 다음 apt 실행 때 감싸기 밖 root 로 돈다(보안 검토 12-7). 거절 목록이 1차, 이것이 2차.
 * /etc/apt 는 트리 전체(sources.list.d, preferences.d, trusted.gpg.d 까지). 꾸러미가 저장소나 키를 더하면 다음 설치부터 공식 밖
 * 꾸러미가 들어온다(12-8 권장)
 */
const HOOK_PATHS = ['/etc/apt', '/etc/dpkg/dpkg.cfg.d', '/etc/ld.so.preload']
/** 감싼 셸이 못 쓰는 러너 상태 아래(RUNNER_READONLY_DIRS). 설치 기록과 임시 폴더 */
const STATE_DIR = process.env.AGENT_RUNNER_STATE_DIR || '/workspace/.agent-runner'
export const SYSTEM_PACKAGES_FILE = () => path.join(STATE_DIR, 'system-packages.json')
const APT_TMP_ROOT = () => path.join(STATE_DIR, 'apt-tmp')
const TIMEOUT_MS = 300_000
/**
 * 기본 이미지에 든 꾸러미 이름(한 줄에 하나). 앱이 이미지를 구울 때 시스템 꾸러미를 깐 직후 적는다(daytona constants.ts SYSTEM_DEPS).
 * /usr 아래라 감싼 셸은 고치지 못한다. 없으면(옛 이미지) 제거를 하지 않는다
 */
const BASE_PACKAGES_FILE = '/usr/share/daiops/base-packages.txt'

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

/**
 * 훅 자리의 사진: 경로 → 내용(Buffer). 폴더는 아래까지 다 본다. 없는 파일은 담지 않는다
 * @returns {Map<string, Buffer>}
 */
export function snapshotHooks(paths = HOOK_PATHS) {
  const out = new Map()
  const walk = (p) => {
    let entries
    try { entries = readdirSync(p, { withFileTypes: true }) } catch {
      try { out.set(p, readFileSync(p)) } catch { /* 없음 */ }
      return
    }
    for (const e of entries) {
      const child = path.join(p, e.name)
      if (e.isDirectory()) walk(child)
      else { try { out.set(child, readFileSync(child)) } catch { out.set(child, Buffer.from('<읽지 못함>')) } }
    }
  }
  for (const p of paths) walk(p)
  return out
}

/** 두 사진이 다른 경로들 */
export function diffHooks(before, after) {
  const changed = []
  for (const [p, buf] of after) if (!before.has(p) || !before.get(p).equals(buf)) changed.push(p)
  for (const p of before.keys()) if (!after.has(p)) changed.push(p)
  return changed
}

/**
 * 바뀐 훅 자리를 설치 전으로 되돌린다. 새 파일은 지우고, 바뀌거나 지워진 파일은 전 내용으로 쓴다.
 * purge 를 부르기 전에 한다. apt 는 실행 시작 때 apt.conf.d 를, dpkg 는 dpkg.cfg.d 를 읽으므로, 되돌리지 않고 purge 하면
 * 방금 들어온 훅이 그 실행에서 감싸기 밖 root 로 한 번 돈다(12-8 권장)
 */
export function restoreHooks(before, after = snapshotHooks()) {
  for (const p of diffHooks(before, after)) {
    try {
      if (before.has(p)) { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, before.get(p)) }
      else rmSync(p, { force: true })
    } catch { /* 남은 것은 아래 다시 비교가 알린다 */ }
  }
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

/** 기록 파일에서 뺀다. 쓰기 실패는 제거 결과를 바꾸지 않는다 */
function recordRemoved(names) {
  try {
    const file = SYSTEM_PACKAGES_FILE()
    let list = []
    try { list = JSON.parse(readFileSync(file, 'utf8')) } catch { return }
    if (!Array.isArray(list)) return
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(list.filter((p) => !names.includes(p?.name)), null, 2))
    renameSync(tmp, file)
  } catch { /* 보조 기록 */ }
}

/** @returns {Set<string> | null} 없거나 비었으면 null */
function readBasePackages(file = BASE_PACKAGES_FILE) {
  try {
    const names = readFileSync(file, 'utf8').split('\n').map((l) => l.trim().replace(/:\w+$/, '')).filter(Boolean)
    return names.length > 0 ? new Set(names) : null
  } catch { return null }
}

/**
 * 설치 미리 보기(바꾸지 않음). 결재 카드와 실행이 같은 판정을 쓴다.
 * @returns {Promise<{ ok: true, installs: {name: string, version: string}[], downloadBytes: number } | { ok: false, error: string }>}
 */
async function previewInstall(names, deps = {}) {
  const run = deps.run ?? defaultRun
  const tmpdir = deps.tmpdir ?? '/tmp'
  const env = aptEnv(tmpdir)
  const hasLists = deps.hasLists ?? (() => { try { return readdirSync(APT_LISTS).some((f) => f.endsWith('_Packages')) } catch { return false } })
  if (!hasLists()) {
    // 이미지가 목록을 지운다. 처음 한 번 받는다
    const up = await run(APT_GET, [...APT_RETRIES, 'update', '-qq'], { env })
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
  const uris = await run(APT_GET, [...APT_RETRIES, 'install', '--print-uris', '-qq', '--no-install-recommends', '--', ...names], { env })
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
  return serialize(() => installCore(v.names, deps))
}

/** 줄 안에서만 부른다(serialize). 이름은 검사를 지난 것 */
async function installCore(names, deps = {}) {
  const v = { names }
  const run = deps.run ?? defaultRun
  {
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
      const hooks = deps.hooks ?? { snapshot: snapshotHooks, restore: restoreHooks }
      const before = hooks.snapshot()
      const res = await run(APT_GET, [...APT_RETRIES, 'install', '-y', '-qq', '--no-install-recommends', '--no-remove', '--no-upgrade', '--', ...pinned], { env: aptEnv(tmpdir) })
      if (diffHooks(before, hooks.snapshot()).length > 0) {
        // 거절 목록을 지나 훅이나 저장소를 바꾼 꾸러미. 훅 자리를 먼저 되돌리고(purge 실행이 새 훅을 돌리지 않게) 이번에 깐 것을 지운다
        hooks.restore(before)
        await run(APT_GET, ['purge', '-y', '-qq', '--', ...preview.installs.map((p) => p.name)], { env: aptEnv(tmpdir) })
        // purge 가 훅 자리를 다시 바꿨으면(설정 파일 지움 등) 한 번 더 되돌린다
        hooks.restore(before)
        const left = diffHooks(before, hooks.snapshot())
        return fail(`these packages change how apt or dpkg runs and were removed${left.length > 0 ? ' (restore was incomplete; the platform team has been notified)' : ''}`)
      }
      if (res.code !== 0) return fail(`apt-get failed (exit ${res.code}): ${tail(res.stdout + res.stderr)}`)
      // 이번에 새로 깐 이름만 기록하고 알린다. 이미 깔려 있던 것(기본 이미지 등)은 앱 승인 목록에 넣지 않게 따로 적는다(보안 검토 15절)
      const fresh = v.names.filter((n) => preview.installs.some((p) => p.name === n))
      const already = v.names.filter((n) => !fresh.includes(n))
      const installed = await queryInstalled(run, tmpdir, fresh)
      recordInstalled(fresh, installed)
      const deps_ = preview.installs.length - fresh.length
      return {
        content: `Installed ${installed.map((p) => `${p.name} ${p.version}`).join(', ')}`
          + (deps_ > 0 ? ` (+${deps_} dependencies)` : '')
          + (already.length > 0 ? `. Already installed: ${already.join(', ')}` : '')
          + `. It will be reinstalled if this workspace is rebuilt.`
          + `\n${SYSTEM_PACKAGES_MARKER} installed=${installed.map((p) => p.name).join(',')}`,
      }
    } finally {
      if (!deps.tmpdir) { try { rmSync(tmpdir, { recursive: true, force: true }) } catch { /* 다음 회차가 덮어쓴다 */ } }
    }
  }
}

/**
 * @param {{ packages?: unknown, reason?: unknown }} input
 * @param {object} [_ctx]
 * @param {{ run?: typeof defaultRun, policyRcD?: () => Promise<number>, basePackages?: () => Set<string> | null }} [deps] 시험용
 */
export async function runRemoveSystemPackage(input, _ctx = {}, deps = {}) {
  const v = validatePackageNames(input)
  if (!v.ok) return removeFail(v.error)
  return serialize(() => removeCore(v.names, deps))
}

const removeFail = (msg) => ({ content: `RemoveSystemPackage: ${msg}`, is_error: true })

async function removeCore(names, deps = {}) {
  const run = deps.run ?? defaultRun
  const base = (deps.basePackages ?? readBasePackages)()
  if (!base) return removeFail('this workspace image does not record which packages it came with, so nothing can be removed safely; it will be possible after the workspace is rebuilt')
  const fromImage = names.filter((n) => base.has(n))
  if (fromImage.length > 0) return removeFail(`these came with the workspace and cannot be removed: ${fromImage.join(', ')}`)
  let tmpdir = deps.tmpdir
  if (!tmpdir) {
    mkdirSync(APT_TMP_ROOT(), { recursive: true })
    tmpdir = mkdtempSync(path.join(APT_TMP_ROOT(), 'remove-'))
  }
  try {
    const rc = deps.policyRcD ? await deps.policyRcD() : (existsSync(POLICY_RC_D) ? (await run(POLICY_RC_D, ['x', 'stop'], { env: aptEnv(tmpdir), timeoutMs: 10_000 })).code : -1)
    if (rc !== 101) return removeFail('this workspace image cannot remove packages safely (policy-rc.d missing); ask the platform team')
    const present = (await queryInstalled(run, tmpdir, names)).map((p) => p.name)
    if (present.length === 0) {
      recordRemoved(names)
      // 깔려 있지 않아도 앱 목록에서는 빼야 다음 재구성이 되살리지 않는다
      return { content: `Not installed: ${names.join(', ')}\n${SYSTEM_PACKAGES_MARKER} removed=${names.join(',')}` }
    }
    const sim = await run(APT_GET, ['purge', '-s', '--', ...present], { env: aptEnv(tmpdir) })
    if (sim.code !== 0) return removeFail(`apt could not plan the removal: ${tail(sim.stdout + sim.stderr, 400)}`)
    const { installs, upgrades, removes } = parseSimulation(sim.stdout)
    if (installs.length > 0 || upgrades.length > 0) return removeFail('removing would install or upgrade other packages')
    // 이름 밖의 꾸러미가 함께 지워지면 그것이 이 꾸러미에 기댄다는 뜻이다. 기본 이미지 꾸러미일 수 있어 거절한다
    const extra = removes.filter((n) => !present.includes(n))
    if (extra.length > 0) return removeFail(`other packages depend on these and would be removed too (${extra.slice(0, 8).join(', ')}); remove nothing`)
    const hooks = deps.hooks ?? { snapshot: snapshotHooks, restore: restoreHooks }
    const before = hooks.snapshot()
    const res = await run(APT_GET, ['purge', '-y', '-qq', '--', ...present], { env: aptEnv(tmpdir) })
    if (diffHooks(before, hooks.snapshot()).length > 0) {
      hooks.restore(before)
      return removeFail('the removal changed how apt or dpkg runs; those files were put back (the platform team has been notified)')
    }
    if (res.code !== 0) return removeFail(`apt-get failed (exit ${res.code}): ${tail(res.stdout + res.stderr)}`)
    const left = (await queryInstalled(run, tmpdir, present)).map((p) => p.name)
    if (left.length > 0) return removeFail(`still installed after removal: ${left.join(', ')}`)
    recordRemoved(names)
    return { content: `Removed ${present.join(', ')}. It will not be reinstalled when this workspace is rebuilt.\n${SYSTEM_PACKAGES_MARKER} removed=${names.join(',')}` }
  } finally {
    if (!deps.tmpdir) { try { rmSync(tmpdir, { recursive: true, force: true }) } catch { /* 같음 */ } }
  }
}

/** 깔려 있는(ii) 꾸러미와 판. 지워졌지만 설정이 남은(rc) 것은 깔린 것으로 보지 않는다 */
async function queryInstalled(run, tmpdir, names) {
  const q = await run(DPKG_QUERY, ['-W', '-f', '${Package}\t${Version}\t${db:Status-Abbrev}\n', '--', ...names], { env: aptEnv(tmpdir), timeoutMs: 10_000 })
  return String(q.stdout).split('\n').filter(Boolean)
    .map((l) => { const [name, version, status] = l.split('\t'); return { name, version, status: status ?? 'ii ' } })
    .filter((p) => p.status.startsWith('ii'))
    .map(({ name, version }) => ({ name, version }))
}

const ensureState = { status: 'idle', key: null, missing: [], failed: [], at: null }
/** /health 에 싣는 다시 깔기 상태 */
export function systemPackagesState() {
  return { ...ensureState, missing: [...ensureState.missing], failed: [...ensureState.failed] }
}

/**
 * 클라우드가 대화 요청마다 보내는 그 직원의 승인 목록(`policy.approvedSystemPackages`)에서 빠진 꾸러미를 뒤에서 다시 깐다.
 * 재구성, 복직으로 새 작업 환경이 되면 첫 대화에서 채워진다(기획 4절, ADR 69 §3 「설치한 꾸러미는 잃는다」 해소). 같은 목록은
 * 부팅마다 한 번만 본다. 같은 이름 검사, 같은 -s 규칙, 같은 줄(AI 팀원의 설치 요청은 이것이 끝날 때까지 기다린다)
 */
export function ensureApprovedSystemPackages(list, deps = {}) {
  const names = [...new Set((Array.isArray(list) ? list : []).map((n) => String(n).trim()))]
    .filter((n) => PACKAGE_NAME.test(n) && !isDeniedPackage(n))
    .sort()
  const key = names.join(' ')
  if (names.length === 0 || key === ensureState.key) return Promise.resolve(systemPackagesState())
  ensureState.key = key
  ensureState.status = 'running'
  return serialize(async () => {
    const run = deps.run ?? defaultRun
    try {
      const installed = new Set((await queryInstalled(run, deps.tmpdir ?? '/tmp', names)).map((p) => p.name))
      const missing = names.filter((n) => !installed.has(n))
      ensureState.missing = missing
      ensureState.failed = []
      for (let i = 0; i < missing.length; i += MAX_PACKAGES) {
        const chunk = missing.slice(i, i + MAX_PACKAGES)
        const r = await installCore(chunk, deps)
        if (r.is_error) ensureState.failed.push(...chunk.map((name) => ({ name, error: String(r.content).slice(0, 300) })))
      }
      ensureState.status = ensureState.failed.length > 0 ? 'failed' : 'ok'
    } catch (err) {
      ensureState.status = 'failed'
      ensureState.failed = [{ name: '*', error: err instanceof Error ? err.message : String(err) }]
    }
    ensureState.at = new Date().toISOString()
    return systemPackagesState()
  })
}

/** 시험용 */
export function resetSystemPackagesStateForTest() {
  Object.assign(ensureState, { status: 'idle', key: null, missing: [], failed: [], at: null })
}
