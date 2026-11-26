/**
 * 도구 명령 감싸기(tool-sandbox.js). 실제 bubblewrap 은 개발 노트북에 없어 spawn, exists 를 바꿔 끼운다.
 * 실제 감싸기의 동작은 러너가 부팅 때 스스로 점검해 /health.toolSandbox 에 싣는다(그 점검 로직을 여기서 본다).
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  buildSandboxArgs,
  runSelfCheck,
  initToolSandbox,
  wrapToolSpawn,
  toolSandboxState,
  RUNNER_READONLY_DIRS,
  SYSTEM_READONLY_DIRS,
  APP_STAGING_DIRS,
  WRAPPED_HOME,
  ROOT_NODE_MODULES,
  PACKAGE_STATE_DIRS,
  ancestorsOf,
  isProcMountFailure,
  toolSandboxRefusal,
  PROC_COVER_DIRS,
  _resetToolSandboxForTest,
} from './tool-sandbox.js'

const SKILLS = '/workspace/.daiops/skills/'

/** 감싼 셸이 내보낼 줄을 정해 두는 가짜 spawnSync */
function fakeSpawn(stdoutLines, { status = 0, error } = {}) {
  const calls = []
  const spawn = (file, args) => {
    calls.push({ file, args })
    return { status, error, stdout: stdoutLines.join('\n'), stderr: '' }
  }
  return { spawn, calls }
}

// parentMove, jobsMeta 는 그 폴더가 있을 때만 기대에 든다(root 로 돌면 /workspace 아래가 실제로 생긴다). 늘 넣어 둔다
const PASS_LINES = ['runner=blocked', 'runnerState=blocked', 'protected=blocked', 'jobsMeta=blocked', 'bwrapDir=blocked', 'etc=blocked', 'rootHome=blocked', 'appStaging=blocked', 'rootNodeModules=blocked', 'dpkgState=blocked', 'aptArchives=blocked', 'home=moved', 'tmp=written', 'umount=blocked', 'parentMove=blocked', 'runnerPid=hidden']

describe('buildSandboxArgs', () => {
  it('러너 폴더와 보호 경로를 읽기 전용으로 덮고, 잡 폴더만 다시 연다', () => {
    const args = buildSandboxArgs({ protectedPaths: [SKILLS, '/workspace/schema/persona.yaml'] })
    const joined = args.join(' ')
    for (const dir of RUNNER_READONLY_DIRS) assert.match(joined, new RegExp(`--ro-bind-try ${dir} ${dir}`))
    assert.match(joined, /--ro-bind-try \/workspace\/\.daiops\/skills \/workspace\/\.daiops\/skills/)
    assert.match(joined, /--ro-bind-try \/workspace\/schema\/persona\.yaml/)
    // 잡 폴더는 러너 상태보다 뒤에 와야 이긴다
    const jobsAt = args.indexOf('/workspace/.agent-runner/jobs')
    assert.ok(jobsAt > args.lastIndexOf('/workspace/.agent-runner'), joined)
    assert.equal(args.at(-1), '--')
  })

  // 보안 검토 11-26 「가」: 덮은 폴더의 부모를 옮기고 같은 이름으로 새로 만들면 밖은 가짜를 본다
  it('보호 경로와 러너 폴더의 부모 사슬을 제자리에 쓰기로 다시 붙인다(옮기기 EBUSY), 덮기보다 먼저', () => {
    const args = buildSandboxArgs({ protectedPaths: [SKILLS, '/workspace/schema/persona.yaml'] })
    const binds = []
    for (let i = 0; i < args.length; i++) if (args[i] === '--bind-try') binds.push(args[i + 1])
    for (const dir of ['/opt', '/workspace', '/workspace/.daiops', '/workspace/schema']) {
      assert.ok(binds.includes(dir), dir)
      assert.ok(args.indexOf(dir) < args.indexOf('/opt/agent-runner'), `${dir} 는 읽기 전용 덮기보다 먼저`)
    }
    assert.ok(!binds.includes('/'))
  })

  // 보안 검토 11-26 6-3: 감싼 셸이 /usr/bin/bwrap 을 바꿔치기해 감싸기를 벗어났다
  it('시스템 폴더를 읽기 전용으로 덮는다, 부모 사슬보다 뒤, 러너 폴더보다 앞', () => {
    const args = buildSandboxArgs({ protectedPaths: [SKILLS] })
    const ro = []
    for (let i = 0; i < args.length; i++) if (args[i] === '--ro-bind-try') ro.push(i)
    const roAt = (dir) => ro.find((i) => args[i + 1] === dir && args[i + 2] === dir)
    for (const dir of SYSTEM_READONLY_DIRS) assert.ok(roAt(dir) !== undefined, dir)
    assert.ok(roAt('/opt') > args.indexOf('/workspace'), '부모 사슬(쓰기 다시 붙이기) 뒤')
    assert.ok(roAt('/opt') < roAt('/opt/agent-runner'), '러너 폴더 덮기 앞')
  })

  // 보안 검토 11-27 10절: 감싼 셸이 ~/.bashrc, ~/.local 의 .pth, 앱 스크립트 폴더의 json.py 로 감싸기 밖 실행을 심었다
  it('HOME 을 작업 폴더 아래로 옮기고 /root 와 앱 스크립트 폴더를 읽기 전용으로 덮는다', () => {
    const args = buildSandboxArgs({ protectedPaths: [SKILLS] })
    const joined = args.join(' ')
    assert.match(joined, new RegExp(`--setenv HOME ${WRAPPED_HOME}`))
    assert.ok(WRAPPED_HOME.startsWith('/workspace/'))
    assert.match(joined, /--ro-bind-try \/root \/root/)
    // 감싸기 밖 node 가 /opt 아래 스크립트에서 모듈을 찾아 올라가는 마지막 자리(11절 probe13)
    assert.match(joined, new RegExp(`--ro-bind-try ${ROOT_NODE_MODULES} ${ROOT_NODE_MODULES}`))
    // 감싸기 밖 apt, dpkg 가 읽는 상태 자리(12-1 probe15)
    for (const dir of PACKAGE_STATE_DIRS) assert.match(joined, new RegExp(`--ro-bind-try ${dir} ${dir}`))
    for (const dir of APP_STAGING_DIRS) assert.match(joined, new RegExp(`--ro-bind-try ${dir.replace(/\./g, '\\.')} `))
    // 앱 스크립트 폴더의 부모(/workspace/.daiops)는 쓰기로 다시 붙여 옮기기를 막는다
    const binds = []
    for (let i = 0; i < args.length; i++) if (args[i] === '--bind-try') binds.push(args[i + 1])
    assert.ok(binds.includes('/workspace/.daiops'))
  })

  it('ancestorsOf 는 얕은 것부터, 대상 자신과 / 는 빼고', () => {
    assert.deepEqual(ancestorsOf(['/a/b/c', '/a/b', '/x/y']), ['/a', '/x'])
    assert.deepEqual(ancestorsOf(['/workspace/.daiops/skills']), ['/workspace', '/workspace/.daiops'])
  })

  it('.. 가 든 보호 항목은 건너뛴다', () => {
    // /etc 는 이제 늘 시스템 폴더로 덮이므로, .. 가 든 항목 자체가 인자에 없는지로 본다
    assert.ok(!buildSandboxArgs({ protectedPaths: ['/workspace/../etc/'] }).some((a) => a.includes('..')))
  })

  it('권한을 내리고 user, pid namespace 를 새로 만든다', () => {
    const args = buildSandboxArgs()
    for (const flag of ['--unshare-user', '--unshare-pid']) assert.ok(args.includes(flag), flag)
    assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL'])
  })

  it('포그라운드는 러너와 함께 죽고, 백그라운드는 러너보다 오래 산다', () => {
    assert.ok(buildSandboxArgs().includes('--die-with-parent'))
    assert.ok(!buildSandboxArgs({ background: true }).includes('--die-with-parent'))
  })

  it('절대경로가 아닌 보호 항목은 건너뛴다', () => {
    assert.ok(!buildSandboxArgs({ protectedPaths: ['relative/x'] }).join(' ').includes('relative'))
  })
})

describe('runSelfCheck', () => {
  it('모두 기대와 같으면 통과', () => {
    const { spawn, calls } = fakeSpawn(PASS_LINES)
    const r = runSelfCheck('/usr/bin/bwrap', { spawn, runnerPid: 4242, protectedDir: '/tmp' })
    assert.equal(r.pass, true, r.reason)
    assert.equal(calls[0].file, '/usr/bin/bwrap')
  })

  for (const [name, bad] of [['protected', 'written'], ['umount', 'done'], ['runnerPid', 'visible'], ['tmp', 'blocked'], ['bwrapDir', 'written'], ['etc', 'written'], ['dpkgState', 'written'], ['rootHome', 'written'], ['home', 'same']]) {
    it(`${name}=${bad} 이면 실패하고 사유에 남긴다`, () => {
      const lines = PASS_LINES.map((l) => (l.startsWith(`${name}=`) ? `${name}=${bad}` : l))
      const r = runSelfCheck('/usr/bin/bwrap', { spawn: fakeSpawn(lines).spawn, runnerPid: 4242, protectedDir: '/tmp' })
      assert.equal(r.pass, false)
      assert.match(r.reason, new RegExp(`${name}=${bad}`))
    })
  }

  it('부모 옮기기와 잡 메타 쓰기도 본다(보호 폴더 부모, 메타 폴더가 있을 때)', async () => {
    const { mkdtempSync, mkdirSync: mk } = await import('node:fs')
    const os = await import('node:os')
    const root = mkdtempSync(path.join(os.tmpdir(), 'selfcheck-'))
    const protectedDir = path.join(root, 'daiops', 'skills')
    const jobsMetaDir = path.join(root, 'jobs-meta')
    mk(protectedDir, { recursive: true }); mk(jobsMetaDir)
    const run = (extra) => {
      const fake = fakeSpawn([...PASS_LINES, ...extra])
      const r = runSelfCheck('/usr/bin/bwrap', { spawn: fake.spawn, runnerPid: 4242, protectedDir, jobsMetaDir })
      return { r, script: fake.calls[0].args.at(-1) }
    }
    const ok = run([])
    assert.equal(ok.r.pass, true, ok.r.reason)
    assert.match(ok.script, /mv '.*daiops'/)
    assert.match(ok.script, /jobs-meta/)
    // 뒤에 온 줄이 이긴다(같은 이름은 덮어씀)
    assert.match(run(['parentMove=done']).r.reason, /parentMove=done/)
    assert.match(run(['jobsMeta=written']).r.reason, /jobsMeta=written/)
    const noParent = fakeSpawn(PASS_LINES.filter((l) => !l.startsWith('parentMove=')))
    assert.match(runSelfCheck('/usr/bin/bwrap', { spawn: noParent.spawn, runnerPid: 4242, protectedDir, jobsMetaDir }).reason, /parentMove=없음/)
  })

  it('감싼 셸이 아예 안 뜨면 실패', () => {
    const r = runSelfCheck('/usr/bin/bwrap', { spawn: fakeSpawn([], { status: 1 }).spawn, runnerPid: 4242, protectedDir: '/tmp' })
    assert.equal(r.pass, false)
    assert.match(r.reason, /실행 실패/)
  })

  it('러너 번호가 작으면 pid 점검은 건너뛴다(새 namespace 번호와 겹칠 수 있다)', () => {
    const lines = PASS_LINES.filter((l) => !l.startsWith('runnerPid='))
    assert.equal(runSelfCheck('/usr/bin/bwrap', { spawn: fakeSpawn([...lines, 'runnerPid=skipped']).spawn, runnerPid: 7, protectedDir: '/tmp' }).pass, true)
  })
})

describe('initToolSandbox, wrapToolSpawn', () => {
  const prev = process.env.AGENT_RUNNER_TOOL_SANDBOX
  beforeEach(() => { _resetToolSandboxForTest(); delete process.env.AGENT_RUNNER_TOOL_SANDBOX })
  afterEach(() => {
    _resetToolSandboxForTest()
    if (prev === undefined) delete process.env.AGENT_RUNNER_TOOL_SANDBOX
    else process.env.AGENT_RUNNER_TOOL_SANDBOX = prev
  })

  const plain = { file: '/bin/bash', args: ['-c', 'echo hi'] }

  it('bubblewrap 이 없으면 감싸지 않고 사유를 남긴다', () => {
    const s = initToolSandbox({ exists: () => false })
    assert.equal(s.enabled, false)
    assert.match(s.reason, /bubblewrap 없음/)
    assert.deepEqual(wrapToolSpawn(plain), plain)
  })

  it('점검에 실패하면 감싸지 않는다', () => {
    const s = initToolSandbox({ exists: () => true, spawn: fakeSpawn(['protected=written']).spawn })
    assert.equal(s.enabled, false)
    assert.match(s.reason, /점검 불일치/)
    assert.deepEqual(wrapToolSpawn(plain), plain)
  })

  it('점검을 통과하면 bwrap 으로 감싸고 원래 명령을 -- 뒤에 둔다', () => {
    const lines = PASS_LINES.map((l) => (l.startsWith('runnerPid=') && process.pid <= 10 ? 'runnerPid=skipped' : l))
    const s = initToolSandbox({ exists: (p) => p === '/usr/bin/bwrap', spawn: fakeSpawn(lines).spawn })
    assert.equal(s.enabled, true, s.reason)
    const w = wrapToolSpawn(plain, { protectedPaths: ['/workspace/schema/persona.yaml'] })
    assert.equal(w.file, '/usr/bin/bwrap')
    const dash = w.args.indexOf('--')
    assert.deepEqual(w.args.slice(dash + 1), ['/bin/bash', '-c', 'echo hi'])
    assert.ok(w.args.join(' ').includes('/workspace/schema/persona.yaml'))
    assert.equal(toolSandboxState().wrapped, 1)
  })

  // 11-26 Daytona 미리보기: 새 /proc 를 못 붙여 감싸기가 꺼졌다. Codex 처럼 --proc 없이 다시 점검한다
  const PROC_FAIL = "bwrap: Can't mount proc on /newroot/proc: Invalid argument"
  it('새 /proc 를 못 붙이면 --proc 없이 다시 점검하고, 러너 메모리, 환경 변수 읽기 막힘까지 봐야 켠다', () => {
    const calls = []
    const spawn = (file, args) => {
      calls.push(args)
      if (args.includes('--proc')) return { status: 1, stdout: '', stderr: PROC_FAIL }
      const lines = [...PASS_LINES, 'runnerMem=blocked', 'runnerEnv=blocked', 'procSys=ro'].map((l) => (l.startsWith('runnerPid=') && process.pid <= 10 ? 'runnerPid=skipped' : l))
      return { status: 0, stdout: lines.join('\n'), stderr: '' }
    }
    const s = initToolSandbox({ exists: (p) => p === '/usr/bin/bwrap', spawn })
    assert.equal(s.enabled, true, s.reason)
    assert.equal(s.mountProc, false)
    assert.equal(calls.length, 2)
    assert.match(calls[1].at(-1), /\/proc\/\d+\/environ/)
    const wrapped = wrapToolSpawn(plain).args
    assert.ok(!wrapped.includes('--proc'), '감쌀 때도 --proc 없이')
    for (const p of PROC_COVER_DIRS) assert.ok(wrapped.join(' ').includes(`--ro-bind-try ${p} ${p}`), p)
  })

  it('--proc 없이 다시 한 점검에서 러너 환경 변수가 읽히면 켜지 않는다', () => {
    const spawn = (file, args) => args.includes('--proc')
      ? { status: 1, stdout: '', stderr: PROC_FAIL }
      : { status: 0, stdout: [...PASS_LINES, 'runnerMem=blocked', 'runnerEnv=read', 'procSys=ro'].join('\n'), stderr: '' }
    const s = initToolSandbox({ exists: () => true, spawn })
    assert.equal(s.enabled, false)
    assert.match(s.reason, /runnerEnv=read/)
  })

  // 재확인 B: 바깥 /proc 번호는 겹치지 않으니 러너가 pid 1 이어도 메모리, 환경 변수 점검을 건너뛰지 않는다
  it('바깥 /proc 모드에서는 러너가 pid 1 이어도 runnerMem, runnerEnv, procSys 를 본다', () => {
    const { spawn, calls } = fakeSpawn([...PASS_LINES.filter((l) => !l.startsWith('runnerPid=')), 'runnerPid=skipped'])
    const r = runSelfCheck('/usr/bin/bwrap', { spawn, runnerPid: 1, protectedDir: '/tmp', mountProc: false })
    assert.equal(r.pass, false)
    assert.match(r.reason, /runnerMem=없음/)
    assert.match(r.reason, /procSys=없음/)
    assert.match(calls[0].args.at(-1), /\/proc\/1\/mem/)
  })

  it('바깥 /proc 모드에서 /proc/sys 가 쓰기로 붙어 있으면 켜지 않는다', () => {
    const lines = [...PASS_LINES, 'runnerMem=blocked', 'runnerEnv=blocked', 'procSys=rw']
    const r = runSelfCheck('/usr/bin/bwrap', { spawn: fakeSpawn(lines).spawn, runnerPid: 4242, protectedDir: '/tmp', mountProc: false })
    assert.equal(r.pass, false)
    assert.match(r.reason, /procSys=rw/)
  })

  it('/proc 문구가 아닌 실패는 다시 하지 않는다', () => {
    let n = 0
    const s = initToolSandbox({ exists: () => true, spawn: () => { n++; return { status: 1, stdout: '', stderr: 'bwrap: pivot_root: Operation not permitted' } } })
    assert.equal(s.enabled, false)
    assert.equal(n, 1)
    assert.equal(isProcMountFailure('감싼 셸 실행 실패: exit 1 ' + PROC_FAIL), true)
    assert.equal(isProcMountFailure('bwrap: pivot_root: Operation not permitted'), false)
  })

  // 대표 결정 11-26: bubblewrap 이 있는데 점검이 실패하면(고장) 터미널을 막는다. 없으면(옛 샌드박스) 그대로 돈다
  it('bubblewrap 이 있는데 점검이 실패하면 blocking 이고 거절 안내를 낸다', () => {
    const s = initToolSandbox({ exists: () => true, spawn: fakeSpawn(['protected=written']).spawn })
    assert.equal(s.enabled, false)
    assert.equal(s.blocking, true)
    assert.match(toolSandboxRefusal(), /Bash is unavailable/)
  })

  it('bubblewrap 이 없으면 막지 않는다(옛 샌드박스)', () => {
    const s = initToolSandbox({ exists: () => false })
    assert.equal(s.blocking, false)
    assert.equal(toolSandboxRefusal(), null)
  })

  it('끄기 스위치면 막지 않는다', () => {
    process.env.AGENT_RUNNER_TOOL_SANDBOX = 'off'
    const s = initToolSandbox({ exists: () => true, spawn: fakeSpawn(['protected=written']).spawn })
    assert.equal(s.blocking, false)
    assert.equal(toolSandboxRefusal(), null)
  })

  it('점검을 통과하면 막지 않는다', () => {
    const lines = PASS_LINES.map((l) => (l.startsWith('runnerPid=') && process.pid <= 10 ? 'runnerPid=skipped' : l))
    initToolSandbox({ exists: (p) => p === '/usr/bin/bwrap', spawn: fakeSpawn(lines).spawn })
    assert.equal(toolSandboxRefusal(), null)
  })

  it('AGENT_RUNNER_TOOL_SANDBOX=off 면 점검도 하지 않는다', () => {
    process.env.AGENT_RUNNER_TOOL_SANDBOX = 'off'
    let spawned = false
    const s = initToolSandbox({ exists: () => true, spawn: () => { spawned = true; return { status: 0, stdout: '' } } })
    assert.equal(s.enabled, false)
    assert.equal(spawned, false)
  })
})
