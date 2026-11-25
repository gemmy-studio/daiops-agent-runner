/**
 * 도구 명령 감싸기(tool-sandbox.js). 실제 bubblewrap 은 개발 노트북에 없어 spawn, exists 를 바꿔 끼운다.
 * 실제 감싸기의 동작은 러너가 부팅 때 스스로 점검해 /health.toolSandbox 에 싣는다(그 점검 로직을 여기서 본다).
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSandboxArgs,
  runSelfCheck,
  initToolSandbox,
  wrapToolSpawn,
  toolSandboxState,
  RUNNER_READONLY_DIRS,
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

const PASS_LINES = ['runner=blocked', 'runnerState=blocked', 'protected=blocked', 'tmp=written', 'umount=blocked', 'runnerPid=hidden']

describe('buildSandboxArgs', () => {
  it('러너 폴더와 보호 경로를 읽기 전용으로 덮고, 잡 폴더만 다시 연다', () => {
    const args = buildSandboxArgs({ protectedPaths: [SKILLS, '/workspace/schema/persona.yaml'] })
    const joined = args.join(' ')
    for (const dir of RUNNER_READONLY_DIRS) assert.match(joined, new RegExp(`--ro-bind-try ${dir} ${dir}`))
    assert.match(joined, /--ro-bind-try \/workspace\/\.daiops\/skills \/workspace\/\.daiops\/skills/)
    assert.match(joined, /--ro-bind-try \/workspace\/schema\/persona\.yaml/)
    // 잡 폴더는 러너 상태보다 뒤에 와야 이긴다
    const jobsAt = args.indexOf('--bind-try')
    assert.ok(jobsAt > args.lastIndexOf('/workspace/.agent-runner'), joined)
    assert.equal(args.at(-1), '--')
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

  for (const [name, bad] of [['protected', 'written'], ['umount', 'done'], ['runnerPid', 'visible'], ['tmp', 'blocked']]) {
    it(`${name}=${bad} 이면 실패하고 사유에 남긴다`, () => {
      const lines = PASS_LINES.map((l) => (l.startsWith(`${name}=`) ? `${name}=${bad}` : l))
      const r = runSelfCheck('/usr/bin/bwrap', { spawn: fakeSpawn(lines).spawn, runnerPid: 4242, protectedDir: '/tmp' })
      assert.equal(r.pass, false)
      assert.match(r.reason, new RegExp(`${name}=${bad}`))
    })
  }

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

  it('AGENT_RUNNER_TOOL_SANDBOX=off 면 점검도 하지 않는다', () => {
    process.env.AGENT_RUNNER_TOOL_SANDBOX = 'off'
    let spawned = false
    const s = initToolSandbox({ exists: () => true, spawn: () => { spawned = true; return { status: 0, stdout: '' } } })
    assert.equal(s.enabled, false)
    assert.equal(spawned, false)
  })
})
