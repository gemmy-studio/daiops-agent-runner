/**
 * 도구 명령 감싸기(bubblewrap) — 직원 터미널에서 러너 프로그램과 업무 방식 파일을 **쓰지 못하게** 한다.
 * 보안 2차-가 2-2(업무 방식 파일), 2-3(러너 자기 보호), 2026-11-25 대표 결정 (a)안.
 *
 * ## 왜
 *
 * 명령 문자열 판정(handler.js `bashProtectedWriteTarget`)은 스크립트 파일, `python -c` 로 우회된다. 그리고
 * 도구가 root 에 권한 전부(CapEff 000001ffffffffff, 11-25 미리보기 실측)로 돌아 러너 코드(`/opt/agent-runner`),
 * 러너 상태, 러너 프로세스까지 손댈 수 있었다. 결재를 한 번 통과한 명령이 결재 판정 자체를 끌 수 있다.
 *
 * ## 레퍼런스
 *
 * Codex CLI(`codex-rs/linux-sandbox/src/bwrap.rs` create_filesystem_args)와 Claude Code 샌드박스(sandbox-runtime
 * generateFilesystemArgs)가 같은 방식이다: 도구 프로세스를 bubblewrap 으로 감싸고, 쓰기 폴더 안의 보호 경로를
 * `--ro-bind` 로 덮는다. Landlock 은 「쓰기 폴더 안 일부만 읽기 전용」을 못 해 Codex 도 옛 방식으로만 남겼다.
 *
 * ## 무엇을 하나
 *
 *  - `/` 는 그대로 쓰기로 두고(지금 도구가 쓰는 곳을 깨지 않는다) 러너 폴더, 러너 상태, 보호 경로만 읽기 전용으로 덮는다.
 *    러너 상태 안의 잡 폴더(`jobs/`)는 백그라운드 잡이 로그와 종료 코드를 써야 해 다시 쓰기로 연다.
 *  - user, pid namespace 를 새로 만들고 권한을 모두 내린다(`--cap-drop ALL`). 그래서 덮은 마운트를 풀 수 없고
 *    (umount, remount 에 CAP_SYS_ADMIN 필요), 러너 프로세스가 보이지 않는다(kill, /proc/<pid>/mem 불가).
 *  - 업무 방식 파일을 **고치는** 일은 이 밖의 정식 길(앱이 Daytona 파일 API 로 쓰고 권한, 칸, 결재, 변경 기록을
 *    거친다)이라 영향이 없다. 러너 자신의 Write/Edit 도구도 러너 프로세스라 감싸지 않는다(보호 경로는 handler 가 거절).
 *
 * ## 켜는 조건 — 부팅 때 스스로 점검한다
 *
 * 감싸기가 실제로 걸리는지는 환경(커널, seccomp, 권한)에 달려 있다. 부팅 때 한 번 감싼 셸로 「막혀야 할 쓰기가
 * 막히고, 되어야 할 쓰기가 되는지」를 돌려 보고, 통과해야 켠다. 결과는 `/health.toolSandbox` 에 싣는다
 * (직원에게 시험을 시키면 탈출 시도로 보고 거절한다. 11-25 미리보기 2회 실측).
 * 통과하지 못하면 지금처럼 감싸지 않고 돈다(조용한 실패를 막으려고 사유를 함께 싣는다). 통과 못 할 때 명령을
 * 막을지(안전 쪽)는 대표 결정을 기다린다. `AGENT_RUNNER_TOOL_SANDBOX=off` 로 끌 수 있다.
 *
 * ## 새 /proc 를 못 붙이는 환경
 *
 * Daytona 미리보기(11-26)는 bwrap 의 `--proc /proc` 를 EINVAL 로 거절했다. Codex 처럼 그 문구면 `--proc` 없이 다시
 * 점검한다. 그때 감싼 셸은 `--bind / /` 로 따라온 바깥 /proc 를 보아 러너의 번호, 명령줄은 보이지만, 메모리와 환경 변수는
 * user namespace 밖이라 읽히지 않고(ptrace 권한), 신호는 pid namespace 가 달라 닿지 않는다. 이 둘을 점검에 넣었다.
 *
 * ## 알려진 한계
 *
 *  - 없는 보호 **파일**(예: 아직 없는 persona_overrides.yaml)은 덮을 자리가 없어 감싼 셸이 새로 만들 수 있다.
 *    보호 **폴더**는 감싸기 전에 만들어 둔다. 파일은 명령 문자열 판정이 계속 본다.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { resolveJobsDir, resolveJobsMetaDir } from './job-keepalive.js'
import path from 'node:path'

const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap']
/** 러너 프로그램(구운 판)과 러너 상태(로그, 이벤트 버퍼, 감시 스크립트, 판 올림 사본). 예외 없이 읽기 전용 */
export const RUNNER_READONLY_DIRS = ['/opt/agent-runner', '/workspace/.agent-runner']
/** bwrap 이 --proc 때 읽기 전용으로 덮는 곳(bubblewrap cover_proc_dirs). 바깥 /proc 를 쓸 때 직접 덮는다 */
export const PROC_COVER_DIRS = ['/proc/sys', '/proc/sysrq-trigger', '/proc/irq', '/proc/bus']
/** 백그라운드 잡 로그와 종료 코드(`tools/bash.js`). 러너 상태 안이지만 잡이 써야 한다 */
const JOBS_DIR = resolveJobsDir

const state = {
  mode: 'auto',
  enabled: false,
  /** 새 /proc 를 붙이는가. 붙이지 못하는 환경(11-26 Daytona 미리보기: EINVAL)에서는 false 로 다시 점검한다 */
  mountProc: true,
  bwrap: null,
  selfCheck: null,
  reason: 'not initialized',
  wrapped: 0,
}
let initialized = false

/**
 * 감싸기 인자. `background` 는 러너가 다시 떠도 살아야 해 `--die-with-parent` 를 붙이지 않는다
 * (백그라운드 잡은 keepalive 로 러너보다 오래 산다. 끝낼 때는 KillShell 이 프로세스 그룹에 신호를 보낸다).
 * `mountProc` 가 false 면 새 /proc 를 붙이지 않고 `--bind / /` 로 따라온 바깥 /proc 를 그대로 쓴다(아래 initToolSandbox).
 * @param {{ protectedPaths?: string[], background?: boolean, mountProc?: boolean }} [opts]
 */
export function buildSandboxArgs({ protectedPaths = [], background = false, mountProc = state.mountProc } = {}) {
  const args = [
    '--bind', '/', '/',
    '--dev', '/dev',
    ...(mountProc ? ['--proc', '/proc'] : []),
    '--unshare-user', '--uid', '0', '--gid', '0',
    '--unshare-pid',
    '--cap-drop', 'ALL',
  ]
  if (!background) args.push('--die-with-parent')
  const protectedTargets = protectedPaths
    .map((p) => String(p).replace(/\/+$/, ''))
    .filter((t) => t.startsWith('/') && !t.split('/').includes('..'))
  // 덮은 폴더 자체는 옮길 수 없지만(EBUSY) 그 부모는 옮겨진다. 부모를 옮기고 같은 이름으로 새로 만들면 밖(러너, 앱)은
  // 가짜를 본다(보안 검토 11-26 「가」). 부모 사슬을 제자리에 다시 붙여(쓰기 그대로) 마운트 지점으로 만들면 옮기기가 EBUSY 다.
  // 권한을 모두 내린 user namespace 라 감싼 셸은 이 마운트를 풀지 못한다. 얕은 것부터 붙인다(나중 마운트가 위에 얹힌다)
  for (const dir of ancestorsOf([...RUNNER_READONLY_DIRS, ...protectedTargets])) args.push('--bind-try', dir, dir)
  for (const dir of RUNNER_READONLY_DIRS) args.push('--ro-bind-try', dir, dir)
  // 나중 마운트가 이긴다: 잡 폴더만 다시 쓰기로 연다. 잡 메타는 러너 상태(읽기 전용) 쪽 jobs-meta 에 있다
  const jobs = JOBS_DIR()
  args.push('--bind-try', jobs, jobs)
  for (const target of protectedTargets) args.push('--ro-bind-try', target, target)
  // --proc 가 하던 덮기(bwrap cover_proc_dirs)가 바깥 /proc 를 쓸 때는 빠진다. 감싼 셸의 uid 0 은 바깥 root 와 같은 번호라
  // sysctl 쓰기 판정을 통과할 수 있으므로 같은 넷을 읽기 전용으로 덮는다(보안 세션 11-26 재확인 A)
  if (!mountProc) for (const p of PROC_COVER_DIRS) args.push('--ro-bind-try', p, p)
  args.push('--')
  return args
}

/** 경로들의 부모 사슬(`/` 제외, 대상 자신 제외), 얕은 것부터. 예: /workspace/.daiops/skills → /workspace, /workspace/.daiops */
export function ancestorsOf(paths) {
  const targets = new Set(paths)
  const out = new Set()
  for (const p of paths) {
    let dir = path.dirname(p)
    while (dir !== '/' && dir !== '.') {
      if (!targets.has(dir)) out.add(dir)
      dir = path.dirname(dir)
    }
  }
  return [...out].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}

/** 보호 폴더(`/` 로 끝나는 항목)를 감싸기 전에 만든다. 없으면 덮을 자리가 없어 감싼 셸이 새로 만들 수 있다 */
function ensureProtectedDirs(protectedPaths) {
  for (const p of protectedPaths) {
    if (typeof p === 'string' && p.endsWith('/') && p.startsWith('/workspace/')) {
      try { mkdirSync(p, { recursive: true }) } catch { /* 만들지 못하면 --ro-bind-try 가 건너뛴다 */ }
    }
  }
  try { mkdirSync(JOBS_DIR(), { recursive: true }) } catch { /* 같음 */ }
  try { mkdirSync(resolveJobsMetaDir(), { recursive: true }) } catch { /* 같음 */ }
}

/**
 * 감싼 셸로 점검한다. 모든 줄이 기대와 같아야 통과.
 * @param {string} bwrap
 * @param {{ spawn?: typeof spawnSync, protectedDir?: string, runnerPid?: number }} [deps]
 */
export function runSelfCheck(bwrap, { spawn = spawnSync, protectedDir = '/workspace/.daiops/skills', runnerPid = process.pid, jobsMetaDir = resolveJobsMetaDir(), mountProc = state.mountProc } = {}) {
  const tag = `.daiops-sandbox-selfcheck-${process.pid}`
  const mustFail = [
    ['runner', `/opt/agent-runner/${tag}`],
    ['runnerState', `/workspace/.agent-runner/${tag}`],
    ['protected', `${protectedDir}/${tag}`],
    // 잡 메타 폴더(러너 상태 안)를 감싼 셸이 쓰면 가짜 메타로 러너를 부릴 수 있다(보안 검토 11-26 「나」「다」)
    ['jobsMeta', `${jobsMetaDir}/${tag}`],
  ].filter(([, f]) => existsSync(path.dirname(f)))
  // 보호 폴더의 부모를 옮길 수 있으면 같은 이름으로 가짜를 세울 수 있다(「가」). 옮겨지면 바로 되돌린다
  const parent = path.dirname(protectedDir)
  const moved = `${parent}.daiops-sandbox-moved-${process.pid}`
  const checkParent = parent !== '/' && existsSync(parent)
  const okFile = `/tmp/${tag}`
  const lines = [
    ...mustFail.map(([name, f]) => `touch '${f}' 2>/dev/null && echo "${name}=written" || echo "${name}=blocked"`),
    `touch '${okFile}' && echo "tmp=written" || echo "tmp=blocked"`,
    `umount '${protectedDir}' 2>/dev/null && echo "umount=done" || echo "umount=blocked"`,
    ...(checkParent ? [`mv '${parent}' '${moved}' 2>/dev/null && { mv '${moved}' '${parent}'; echo "parentMove=done"; } || echo "parentMove=blocked"`] : []),
    // 새 pid namespace 의 번호는 1부터라 러너 번호가 작으면 겹칠 수 있다. 10 넘을 때만 본다
    runnerPid > 10 ? `kill -0 ${runnerPid} 2>/dev/null && echo "runnerPid=visible" || echo "runnerPid=hidden"` : 'echo "runnerPid=skipped"',
    // 바깥 /proc 를 쓰면 러너의 /proc/<pid> 가 보인다. 메모리, 환경 변수는 user namespace 밖이라 읽히지 않아야 한다
    // 바깥 /proc 의 번호는 바깥 번호라 새 namespace 번호와 겹치지 않는다. 러너가 pid 1 이어도 본다(재확인 B)
    ...(!mountProc ? [
      `head -c 1 /proc/${runnerPid}/mem >/dev/null 2>&1 && echo "runnerMem=read" || echo "runnerMem=blocked"`,
      `head -c 1 /proc/${runnerPid}/environ >/dev/null 2>&1 && echo "runnerEnv=read" || echo "runnerEnv=blocked"`,
      // 맨 위 마운트(마지막 줄)의 옵션이 ro 로 시작해야 한다
      `awk '$5=="/proc/sys"{o=$6} END{print (o ~ /^ro/ ? "procSys=ro" : "procSys=" (o == "" ? "none" : "rw"))}' /proc/self/mountinfo`,
    ] : []),
  ]
  const result = {}
  let leaked = []
  try {
    const r = spawn(bwrap, [...buildSandboxArgs({ protectedPaths: [`${protectedDir}/`], mountProc }), '/bin/sh', '-c', lines.join('\n')], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    if (r.error || r.status !== 0) {
      return { pass: false, reason: `감싼 셸 실행 실패: ${r.error?.message ?? `exit ${r.status} ${String(r.stderr ?? '').trim().slice(0, 200)}`}`, result }
    }
    for (const line of String(r.stdout ?? '').split('\n')) {
      const m = line.match(/^(\w+)=(\w+)$/)
      if (m) result[m[1]] = m[2]
    }
  } finally {
    // 새어 나간 시험 파일은 감싸기 밖에서 지우고 실패로 센다
    for (const [, f] of mustFail) {
      if (existsSync(f)) { leaked.push(f); try { rmSync(f, { force: true }) } catch { /* 남으면 다음 점검이 다시 본다 */ } }
    }
    try { rmSync(okFile, { force: true }) } catch { /* 없음 */ }
    // 감싼 셸이 옮기고 되돌리기 전에 죽었으면 밖에서 되돌린다
    if (checkParent && !existsSync(parent) && existsSync(moved)) {
      try { renameSync(moved, parent); leaked.push(`${parent}(옮겨졌다 되돌림)`) } catch { leaked.push(`${parent} 가 ${moved} 로 옮겨짐`) }
    }
  }
  const expected = {
    ...Object.fromEntries(mustFail.map(([name]) => [name, 'blocked'])),
    tmp: 'written',
    umount: 'blocked',
    ...(checkParent ? { parentMove: 'blocked' } : {}),
    ...(runnerPid > 10 ? { runnerPid: 'hidden' } : {}),
    ...(!mountProc ? { runnerMem: 'blocked', runnerEnv: 'blocked', procSys: 'ro' } : {}),
  }
  const wrong = Object.entries(expected).filter(([k, v]) => result[k] !== v).map(([k, v]) => `${k}=${result[k] ?? '없음'}(기대 ${v})`)
  if (leaked.length > 0) wrong.push(`새어 나감: ${leaked.join(', ')}`)
  return wrong.length === 0
    ? { pass: true, reason: null, result }
    : { pass: false, reason: `점검 불일치: ${wrong.join('; ')}`, result }
}

/**
 * 부팅 때 한 번. 실패는 전부 「감싸지 않음」으로 수렴하고 사유를 남긴다.
 * @param {{ spawn?: typeof spawnSync, exists?: (p: string) => boolean }} [deps]
 */
export function initToolSandbox(deps = {}) {
  if (initialized) return state
  initialized = true
  const exists = deps.exists ?? existsSync
  state.mode = process.env.AGENT_RUNNER_TOOL_SANDBOX === 'off' ? 'off' : 'auto'
  if (state.mode === 'off') {
    state.reason = 'AGENT_RUNNER_TOOL_SANDBOX=off'
    return state
  }
  state.bwrap = BWRAP_CANDIDATES.find((p) => exists(p)) ?? null
  if (!state.bwrap) {
    state.reason = 'bubblewrap 없음(샌드박스 이미지에 bubblewrap 이 들어 있어야 한다)'
    return state
  }
  ensureProtectedDirs(['/workspace/.daiops/skills/'])
  let check = runSelfCheck(state.bwrap, { spawn: deps.spawn, mountProc: true })
  // 컨테이너가 새 /proc 붙이기를 막는 환경이 있다(11-26 Daytona 미리보기 「Can't mount proc on /newroot/proc: Invalid
  // argument」). Codex linux-sandbox 도 같은 문구를 보면 --proc 없이 다시 한다(linux_run_main.rs is_proc_mount_failure).
  // 그때는 바깥 /proc 가 보이므로 러너 메모리, 환경 변수가 읽히지 않는지까지 점검해야 켠다
  if (!check.pass && isProcMountFailure(check.reason)) {
    state.mountProc = false
    check = runSelfCheck(state.bwrap, { spawn: deps.spawn, mountProc: false })
  }
  state.selfCheck = check.result
  if (!check.pass) {
    state.reason = check.reason
    return state
  }
  state.enabled = true
  state.reason = null
  return state
}

/** bwrap 이 새 /proc 를 못 붙였다는 문구인가(Codex 와 같은 판정) */
export function isProcMountFailure(reason) {
  const t = String(reason ?? '')
  return t.includes("Can't mount proc") && t.includes('/newroot/proc')
    && (t.includes('Invalid argument') || t.includes('Operation not permitted') || t.includes('Permission denied'))
}

/**
 * 도구 자식 프로세스의 실행 파일과 인자를 감싼다. 꺼져 있으면 그대로 돌려준다.
 * @param {{ file: string, args: string[] }} spawnArgs
 * @param {{ protectedPaths?: string[], background?: boolean }} [opts]
 */
export function wrapToolSpawn(spawnArgs, opts = {}) {
  if (!state.enabled || !state.bwrap) return spawnArgs
  const protectedPaths = Array.isArray(opts.protectedPaths) ? opts.protectedPaths : []
  ensureProtectedDirs(protectedPaths)
  state.wrapped++
  return { file: state.bwrap, args: [...buildSandboxArgs({ protectedPaths, background: opts.background }), spawnArgs.file, ...spawnArgs.args] }
}

/** `/health.toolSandbox` */
export function toolSandboxState() {
  return { ...state, selfCheck: state.selfCheck ? { ...state.selfCheck } : null }
}

export function _resetToolSandboxForTest() {
  initialized = false
  Object.assign(state, { mode: 'auto', enabled: false, mountProc: true, bwrap: null, selfCheck: null, reason: 'not initialized', wrapped: 0 })
}
