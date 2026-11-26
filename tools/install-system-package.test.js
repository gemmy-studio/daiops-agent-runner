import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AGENT_RUNNER_STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'isp-state-'))
const {
  validatePackageNames, parseSimulation, sumDownloadBytes, aptEnv, isDeniedPackage,
  runInstallSystemPackage, SYSTEM_PACKAGES_FILE, MAX_DOWNLOAD_BYTES, previewInstallRequest, ensureApprovedSystemPackages, resetSystemPackagesStateForTest,
  runRemoveSystemPackage,
} = await import('./install-system-package.js')
const { evaluateSystemPackageInstall, evaluateSystemPackageRemove } = await import('../handler.js')

const SIM_FFMPEG = [
  'NOTE: This is only a simulation!',
  'Inst libavutil57 (7:5.1.6-0+deb12u1 Debian:12.8/stable [amd64])',
  'Inst ffmpeg (7:5.1.6-0+deb12u1 Debian:12.8/stable [amd64])',
  'Conf ffmpeg (7:5.1.6-0+deb12u1 Debian:12.8/stable [amd64])',
].join('\n')

/** 명령마다 정한 답을 주고 부른 것을 남기는 가짜 실행기 */
function fakeRun(answers) {
  const calls = []
  const run = async (file, args, opts) => {
    calls.push({ file, args, env: opts?.env })
    const a0 = args[0] === '-o' ? args.slice(2) : args
    const key = `${path.basename(file)} ${a0.slice(0, 2).join(' ')}`
    const a = answers.find(([k]) => key.startsWith(k))
    return a ? { code: 0, stdout: '', stderr: '', ...a[1] } : { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}
const deps = (answers, extra = {}) => {
  const f = fakeRun(answers)
  return { f, d: { run: f.run, hasLists: () => true, policyRcD: async () => 101, tmpdir: '/x/apt-tmp/run-1', ...extra } }
}

describe('validatePackageNames', () => {
  it('이름만 받는다(옵션, 판, 경로, URL, 셸 거절)', () => {
    assert.deepEqual(validatePackageNames({ packages: ['ffmpeg', 'libpq-dev', 'g++', 'ffmpeg'] }), { ok: true, names: ['ffmpeg', 'libpq-dev', 'g++'] })
    for (const bad of ['-o', '--allow-unauthenticated', 'ffmpeg=1.0', './x.deb', 'http://x/y.deb', 'a; rm -rf /', 'FFMPEG', 'a', 'x/y']) {
      assert.equal(validatePackageNames({ packages: [bad] }).ok, false, bad)
    }
    assert.equal(validatePackageNames({ packages: [] }).ok, false)
    assert.equal(validatePackageNames({ packages: Array.from({ length: 11 }, (_, i) => `p${i}x`) }).ok, false)
  })

  it('러너, 감싸기, init 계열은 이름으로도 거절', () => {
    for (const n of ['bubblewrap', 'apt', 'dpkg', 'libc6', 'nodejs', 'python3', 'bash', 'systemd', 'systemd-sysv', 'init', 'libpam-modules', 'linux-image-amd64', 'apparmor', 'sudo']) {
      assert.equal(isDeniedPackage(n), true, n)
    }
    for (const n of ['ffmpeg', 'python3-numpy', 'libpq-dev', 'imagemagick', 'aptitude-doc-en']) assert.equal(isDeniedPackage(n), false, n)
  })

  it('apt, dpkg 훅을 까는 꾸러미는 거절(12-7), 보안 이유 없는 이웃은 막지 않는다(dpkg-dev, node-*)', () => {
    for (const n of ['needrestart', 'apt-listchanges', 'apt-listbugs', 'etckeeper', 'unattended-upgrades', 'debsums']) assert.equal(isDeniedPackage(n), true, n)
    for (const n of ['dpkg-dev', 'build-essential', 'node-lodash', 'apt-transport-https']) assert.equal(isDeniedPackage(n), false, n)
  })
})

describe('parseSimulation, sumDownloadBytes', () => {
  it('새로 깔림, 올림, 지움을 가른다', () => {
    const r = parseSimulation([
      'Inst libc6 [2.36-9+deb12u7] (2.36-9+deb12u9 Debian-Security:12 [amd64])',
      'Inst ffmpeg (7:5.1.6 Debian:12.8/stable [amd64])',
      'Inst libfoo:amd64 (1.2 Debian [amd64])',
      'Remv oldpkg [1.0]',
    ].join('\n'))
    assert.deepEqual(r.upgrades, [{ name: 'libc6', from: '2.36-9+deb12u7', version: '2.36-9+deb12u9' }])
    assert.deepEqual(r.installs, [{ name: 'ffmpeg', version: '7:5.1.6' }, { name: 'libfoo', version: '1.2' }])
    assert.deepEqual(r.removes, ['oldpkg'])
  })

  it('받을 크기를 더한다', () => {
    assert.equal(sumDownloadBytes("'http://deb/a.deb' a.deb 1000 SHA256:x\n'http://deb/b.deb' b.deb 2500 SHA256:y\n"), 3500)
  })
})

describe('runInstallSystemPackage', () => {
  beforeEach(() => {})

  it('미리 본 꾸러미를 모두 이름=판으로, --no-remove --no-upgrade, 새로 짠 환경, cwd 는 실행기가 / 로', async () => {
    const { f, d } = deps([
      ['apt-get install -s', { stdout: SIM_FFMPEG }],
      ['apt-get install --print-uris', { stdout: "'u' a.deb 1000 x\n" }],
      ['dpkg-query -W', { stdout: 'ffmpeg\t7:5.1.6-0+deb12u1\n' }],
    ])
    const r = await runInstallSystemPackage({ packages: ['ffmpeg'], reason: 'video' }, {}, d)
    assert.equal(r.is_error, undefined, r.content)
    assert.match(r.content, /Installed ffmpeg 7:5\.1\.6-0\+deb12u1 \(\+1 dependencies\)/)
    const install = f.calls.find((c) => c.args.includes('install') && c.args.includes('-y'))
    assert.deepEqual(install.args.slice(install.args.indexOf('--') + 1), ['libavutil57=7:5.1.6-0+deb12u1', 'ffmpeg=7:5.1.6-0+deb12u1'])
    for (const flag of ['--no-remove', '--no-upgrade', '--no-install-recommends']) assert.ok(install.args.includes(flag), flag)
    assert.equal(install.file, '/usr/bin/apt-get')
    assert.deepEqual(install.env, aptEnv('/x/apt-tmp/run-1'))
    // 기록(보조)
    const rec = JSON.parse(readFileSync(SYSTEM_PACKAGES_FILE(), 'utf8'))
    assert.equal(rec.find((p) => p.name === 'ffmpeg').version, '7:5.1.6-0+deb12u1')
    assert.ok(!rec.some((p) => p.name === 'libavutil57'), '의존성은 기록하지 않는다')
  })

  it('의존성이 기존 꾸러미를 올리면 거절하고 깔지 않는다(--no-upgrade 가 못 막는 것)', async () => {
    const { f, d } = deps([['apt-get install -s', { stdout: 'Inst libc6 [2.36-9] (2.36-10 Debian [amd64])\n' + SIM_FFMPEG }]])
    const r = await runInstallSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)
    assert.equal(r.is_error, true)
    assert.match(r.content, /upgrade.*libc6/)
    assert.ok(!f.calls.some((c) => c.args.includes('-y')))
  })

  it('지움이 있으면 거절', async () => {
    const { f, d } = deps([['apt-get install -s', { stdout: 'Remv foo [1]\n' + SIM_FFMPEG }]])
    assert.match((await runInstallSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)).content, /remove/)
    assert.ok(!f.calls.some((c) => c.args.includes('-y')))
  })

  it('거절 목록이 의존성으로 딸려 오면 거절', async () => {
    const { d } = deps([['apt-get install -s', { stdout: 'Inst systemd (252 Debian [amd64])\n' + SIM_FFMPEG }]])
    assert.match((await runInstallSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)).content, /dependencies and are not allowed: systemd/)
  })

  it('크기를 못 재면(--print-uris 실패) 거절(12-7)', async () => {
    const { f, d } = deps([
      ['apt-get install -s', { stdout: SIM_FFMPEG }],
      ['apt-get install --print-uris', { code: 100, stdout: 'E: x' }],
    ])
    assert.match((await runInstallSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)).content, /download size could not be measured/)
    assert.ok(!f.calls.some((c) => c.args.includes('-y')))
  })

  it('설치가 apt, dpkg 훅 자리를 바꾸면 purge 전에 되돌리고, 이번에 깐 것을 지우고 실패(12-7, 12-8)', async () => {
    const order = []
    let state = new Map([['/etc/apt/apt.conf.d/70debconf', Buffer.from('a')]])
    const hooks = {
      snapshot: () => new Map(state),
      restore: (before) => { order.push('restore'); state = new Map(before) },
    }
    const { f, d } = deps([
      ['apt-get install -s', { stdout: SIM_FFMPEG }],
      ['apt-get install --print-uris', { stdout: "'u' a.deb 10 x\n" }],
    ], { hooks })
    const run0 = d.run
    d.run = async (file, args, opts) => {
      if (args.includes('install') && args.includes('-y')) state.set('/etc/apt/apt.conf.d/99evil', Buffer.from('DPkg::Pre-Invoke'))
      if (args[0] === 'purge') order.push('purge')
      return run0(file, args, opts)
    }
    const r = await runInstallSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)
    assert.equal(r.is_error, true)
    assert.match(r.content, /change how apt or dpkg runs and were removed$/)
    assert.deepEqual(order.slice(0, 2), ['restore', 'purge'], '되돌리기가 purge 보다 먼저')
    const purge = f.calls.find((c) => c.args[0] === 'purge')
    assert.deepEqual(purge.args.slice(purge.args.indexOf('--') + 1), ['libavutil57', 'ffmpeg'])
  })

  it('훅 사진: 새 파일, 바뀐 파일, 지워진 파일을 잡고 되돌린다(실제 파일)', async () => {
    const { snapshotHooks, diffHooks, restoreHooks } = await import('./install-system-package.js')
    const { mkdtempSync: mk, writeFileSync: w, mkdirSync: md, existsSync: ex, readFileSync: rd, rmSync: rm } = await import('node:fs')
    const root = mk(path.join(os.tmpdir(), 'hooks-'))
    md(path.join(root, 'apt/sources.list.d'), { recursive: true })
    w(path.join(root, 'apt/apt.conf'), 'keep')
    w(path.join(root, 'apt/sources.list.d/debian.sources'), 'deb')
    const paths = [path.join(root, 'apt')]
    const before = snapshotHooks(paths)
    w(path.join(root, 'apt/sources.list.d/evil.list'), 'deb http://evil/ x')
    w(path.join(root, 'apt/apt.conf'), 'changed')
    rm(path.join(root, 'apt/sources.list.d/debian.sources'))
    assert.equal(diffHooks(before, snapshotHooks(paths)).length, 3)
    restoreHooks(before, snapshotHooks(paths))
    assert.equal(diffHooks(before, snapshotHooks(paths)).length, 0)
    assert.equal(ex(path.join(root, 'apt/sources.list.d/evil.list')), false)
    assert.equal(rd(path.join(root, 'apt/apt.conf'), 'utf8'), 'keep')
  })

  it('받을 크기 상한', async () => {
    const { d } = deps([
      ['apt-get install -s', { stdout: SIM_FFMPEG }],
      ['apt-get install --print-uris', { stdout: `'u' a.deb ${MAX_DOWNLOAD_BYTES + 1} x\n` }],
    ])
    assert.match((await runInstallSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)).content, /over the 500 MB limit/)
  })

  it('policy-rc.d 가 101 이 아니면 아무것도 하지 않는다', async () => {
    const { f, d } = deps([], { policyRcD: async () => 0 })
    assert.match((await runInstallSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)).content, /policy-rc\.d/)
    assert.equal(f.calls.length, 0)
  })

  it('목록이 없으면 먼저 받는다', async () => {
    const { f, d } = deps([['apt-get install -s', { stdout: '' }]], { hasLists: () => false })
    await runInstallSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)
    assert.deepEqual(f.calls[0].args, ['-o', 'Acquire::Retries=3', 'update', '-qq'])
  })

  it('이름이 틀리면 apt 를 부르지 않는다', async () => {
    const { f, d } = deps([])
    assert.equal((await runInstallSystemPackage({ packages: ['--force-yes'], reason: 'x' }, {}, d)).is_error, true)
    assert.equal(f.calls.length, 0)
  })

  it('한 번에 하나(dpkg 잠금)', async () => {
    let active = 0
    let maxActive = 0
    const run = async (file, args) => {
      active++; maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return { code: 0, stdout: args.includes('-s') ? SIM_FFMPEG : '', stderr: '' }
    }
    const d = { run, hasLists: () => true, policyRcD: async () => 101, tmpdir: '/x' }
    await Promise.all([1, 2, 3].map(() => runInstallSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)))
    assert.equal(maxActive, 1)
  })
})

describe('previewInstallRequest(결재 카드 미리 보기)', () => {
  it('같은 이름 검사를 거치고, 바꾸는 명령은 부르지 않는다', async () => {
    const { f, d } = deps([
      ['apt-get install -s', { stdout: SIM_FFMPEG }],
      ['apt-get install --print-uris', { stdout: "'u' a.deb 1234 x\n" }],
    ])
    assert.deepEqual(await previewInstallRequest({ packages: ['-o'] }, d), { ok: false, error: "'-o' is not a package name (names only, no options, versions or paths)" })
    const r = await previewInstallRequest({ packages: ['ffmpeg'] }, d)
    assert.deepEqual(r, { ok: true, installs: [{ name: 'libavutil57', version: '7:5.1.6-0+deb12u1' }, { name: 'ffmpeg', version: '7:5.1.6-0+deb12u1' }], downloadBytes: 1234 })
    assert.ok(!f.calls.some((c) => c.args.includes('-y') || c.args[0] === 'purge'))
  })

  it('러너 엔드포인트는 인증 뒤에 있다', () => {
    const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8')
    const auth = src.indexOf('if (!verifyAuth(req)) {')
    const route = src.indexOf("url.pathname === '/v1/system-packages/preview'")
    assert.ok(auth > 0 && route > auth)
  })
})

describe('ensureApprovedSystemPackages(다시 깔기)', () => {
  it('승인 목록에서 빠진 것만 같은 규칙으로 깔고, 같은 목록은 다시 보지 않는다', async () => {
    resetSystemPackagesStateForTest()
    const { f, d } = deps([
      ['dpkg-query -W', { stdout: 'jq\t1.6\tii \nffmpeg\t7:5\trc \n' }],
      ['apt-get install -s', { stdout: SIM_FFMPEG }],
      ['apt-get install --print-uris', { stdout: "'u' a.deb 10 x\n" }],
    ])
    const st = await ensureApprovedSystemPackages(['jq', 'ffmpeg', 'bubblewrap', '-o'], d)
    assert.equal(st.status, 'ok')
    assert.deepEqual(st.missing, ['ffmpeg'], 'rc(설정만 남음)는 빠진 것, 거절 목록과 틀린 이름은 버림')
    const install = f.calls.find((c) => c.args.includes('install') && c.args.includes('-y'))
    assert.ok(install.args.includes('ffmpeg=7:5.1.6-0+deb12u1') && install.args.includes('--no-remove'))
    const n = f.calls.length
    await ensureApprovedSystemPackages(['ffmpeg', 'jq'], d)
    assert.equal(f.calls.length, n, '같은 목록(순서 무관)은 다시 보지 않는다')
  })

  it('하나가 실패해도 상태에 남기고 던지지 않는다', async () => {
    resetSystemPackagesStateForTest()
    const { d } = deps([['apt-get install -s', { stdout: 'Inst libc6 [1] (2 D [amd64])\n' }]])
    const st = await ensureApprovedSystemPackages(['imagemagick'], d)
    assert.equal(st.status, 'failed')
    assert.equal(st.failed[0].name, 'imagemagick')
  })
})

describe('evaluateSystemPackageInstall(결재)', () => {
  const input = { packages: ['ffmpeg'], reason: 'video' }
  it('매번 결재. 전에 결재해 승인 목록에 있어도 다시 묻는다(대표 11-27)', () => {
    const r = evaluateSystemPackageInstall({ approvedSystemPackages: ['ffmpeg'] }, input, true)
    assert.equal(r.kind, 'plan_request')
    assert.match(evaluateSystemPackageInstall({ approvedSystemPackages: [] }, { packages: ['ffmpeg', 'imagemagick'], reason: 'x' }, true).commandSummary, /ffmpeg, imagemagick: x/)
  })
  it('전권 직원도 결재(감싸기 밖 root 라 터미널보다 힘이 크다)', () => {
    assert.equal(evaluateSystemPackageInstall({ security: 'full', approvedSystemPackages: ['ffmpeg'] }, input, true).kind, 'plan_request')
  })
  it('결재할 사람이 없으면 askFallback 과 무관하게 거절', () => {
    assert.equal(evaluateSystemPackageInstall({ askFallback: 'allow', approvedSystemPackages: ['ffmpeg'] }, input, false).kind, 'deny')
  })
})

describe('evaluateSystemPackageRemove(결재)', () => {
  const input = { packages: ['ffmpeg'], reason: 'done' }
  it('이 길로 깐 것(승인 목록)이면 매번 결재', () => {
    const r = evaluateSystemPackageRemove({ approvedSystemPackages: ['ffmpeg'] }, input, true)
    assert.equal(r.kind, 'plan_request')
    assert.equal(r.toolName, 'RemoveSystemPackage')
    assert.match(r.commandSummary, /ffmpeg: done/)
  })
  it('승인 목록 밖 이름(기본 이미지 꾸러미 등)은 결재로 올리지 않고 막는다', () => {
    const r = evaluateSystemPackageRemove({ approvedSystemPackages: ['ffmpeg'] }, { packages: ['ffmpeg', 'git'], reason: 'x' }, true)
    assert.equal(r.kind, 'deny')
    assert.equal(r.reason, 'remove-not-installed-by-request')
    assert.equal(evaluateSystemPackageRemove({}, input, true).kind, 'deny')
  })
  it('전권, askFallback 과 무관. 결재할 사람이 없으면 거절', () => {
    assert.equal(evaluateSystemPackageRemove({ security: 'full', askFallback: 'allow', approvedSystemPackages: ['ffmpeg'] }, input, false).kind, 'deny')
  })
})

describe('runRemoveSystemPackage', () => {
  const base = () => new Set(['git', 'curl', 'libc6'])
  const installedFfmpeg = 'ffmpeg\t7:5.1.6\tii \n'
  it('이 길로 깐 꾸러미만 purge 하고 기록에서 뺀다', async () => {
    const { f, d } = deps([
      ['dpkg-query -W', { stdout: installedFfmpeg }],
      ['apt-get purge -s', { stdout: 'Purg ffmpeg [7:5.1.6]\n' }],
    ], { basePackages: base, hooks: { snapshot: () => new Map(), restore: () => {} } })
    let n = 0
    const run0 = d.run
    d.run = async (file, args, opts) => {
      // 지운 뒤 다시 물으면 없다
      if (path.basename(file) === 'dpkg-query' && n++ > 0) return { code: 0, stdout: '', stderr: '' }
      return run0(file, args, opts)
    }
    const r = await runRemoveSystemPackage({ packages: ['ffmpeg'], reason: 'done' }, {}, d)
    assert.equal(r.is_error, undefined, r.content)
    assert.match(r.content, /Removed ffmpeg/)
    const purge = f.calls.find((c) => c.args[0] === 'purge' && c.args[1] === '-y')
    assert.deepEqual(purge.args.slice(-2), ['--', 'ffmpeg'])
  })
  it('기본 이미지 꾸러미는 지우지 않는다', async () => {
    const { f, d } = deps([], { basePackages: base })
    const r = await runRemoveSystemPackage({ packages: ['git'], reason: 'x' }, {}, d)
    assert.equal(r.is_error, true)
    assert.match(r.content, /came with the workspace/)
    assert.equal(f.calls.length, 0)
  })
  it('기본 이미지 목록이 없으면(옛 이미지) 아무것도 지우지 않는다', async () => {
    const { f, d } = deps([], { basePackages: () => null })
    const r = await runRemoveSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)
    assert.equal(r.is_error, true)
    assert.equal(f.calls.length, 0)
  })
  it('다른 꾸러미가 딸려 지워지면 거절(그것이 기댄다)', async () => {
    const { f, d } = deps([
      ['dpkg-query -W', { stdout: installedFfmpeg }],
      ['apt-get purge -s', { stdout: 'Purg ffmpeg [1]\nPurg some-base-tool [2]\n' }],
    ], { basePackages: base })
    const r = await runRemoveSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)
    assert.match(r.content, /depend on these/)
    assert.equal(f.calls.some((c) => c.args[0] === 'purge' && c.args[1] === '-y'), false)
  })
  it('policy-rc.d 가 101 이 아니면 지우지 않는다', async () => {
    const { d } = deps([], { basePackages: base, policyRcD: async () => 0 })
    assert.match((await runRemoveSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)).content, /policy-rc\.d/)
  })
  it('지우는 동안 훅 자리가 바뀌면 되돌리고 알린다', async () => {
    let snap = 0
    let restored = false
    const { d } = deps([
      ['dpkg-query -W', { stdout: installedFfmpeg }],
      ['apt-get purge -s', { stdout: 'Purg ffmpeg [1]\n' }],
    ], { basePackages: base, hooks: { snapshot: () => new Map(snap++ === 0 ? [] : [['/etc/apt/apt.conf.d/99x', Buffer.from('x')]]), restore: () => { restored = true } } })
    const r = await runRemoveSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)
    assert.equal(r.is_error, true)
    assert.equal(restored, true)
  })
  it('깔려 있지 않으면 아무것도 돌리지 않고 알린다', async () => {
    const { f, d } = deps([], { basePackages: base })
    const r = await runRemoveSystemPackage({ packages: ['ffmpeg'], reason: 'x' }, {}, d)
    assert.match(r.content, /Not installed/)
    assert.equal(f.calls.some((c) => c.args[0] === 'purge'), false)
  })
})

describe('노출', () => {
  it('클라우드가 승인 목록 칸을 보낼 때만 도구가 보인다', () => {
    const src = readFileSync(new URL('../handler.js', import.meta.url), 'utf8')
    assert.match(src, /if \(Array\.isArray\(params\.policy\?\.approvedSystemPackages\)\) \{\n\s+SDK_BUILTIN_TOOLS\.push\(INSTALL_SYSTEM_PACKAGE_TOOL_NAME, REMOVE_SYSTEM_PACKAGE_TOOL_NAME\)/)
    assert.match(src, /if \(toolName === REMOVE_SYSTEM_PACKAGE_TOOL_NAME\) return evaluateSystemPackageRemove\(policy, input, hasUiChannel\)/)
    assert.match(src, /if \(toolName === INSTALL_SYSTEM_PACKAGE_TOOL_NAME\) return evaluateSystemPackageInstall\(policy, input, hasUiChannel\)/)
  })
})
