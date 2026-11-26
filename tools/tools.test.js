import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { runRead } from './read.js'
import { runWrite } from './write.js'
import { runEdit } from './edit.js'
import { runGlob } from './glob.js'
import { runGrep } from './grep.js'
import { runBash } from './bash.js'
import { runBashOutput } from './bash-output.js'
import { runKillShell, killTargetRefusal } from './kill-shell.js'
import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES, runBuiltinTool, isBuiltinTool } from './index.js'
import { buildToolEnv } from './_common.js'

describe('buildToolEnv — 내부 시크릿 스크럽', () => {
  it('AGENT_RUNNER_TOKEN / LLM_PROXY_URL을 자식 env에서 제거', () => {
    const prev = { ...process.env }
    process.env.AGENT_RUNNER_TOKEN = 'secret-token'
    process.env.LLM_PROXY_URL = 'https://x.ngrok-free.app/api/internal/llm/messages'
    process.env.PATH = process.env.PATH ?? '/usr/bin'
    try {
      const env = buildToolEnv()
      assert.equal(env.AGENT_RUNNER_TOKEN, undefined)
      assert.equal(env.LLM_PROXY_URL, undefined)
      assert.ok(env.PATH, 'PATH 등 일반 env는 보존')
    } finally {
      process.env = prev
    }
  })

  it('extra로 넘긴 일반 키는 덮어쓰되, denylist 키는 extra라도 제거', () => {
    const prev = { ...process.env }
    process.env.AGENT_RUNNER_TOKEN = 'secret-token'
    try {
      const env = buildToolEnv({ FOO: 'bar', AGENT_RUNNER_TOKEN: 'override-attempt' })
      assert.equal(env.FOO, 'bar')
      // Phase B 격리: extra(세션 secret)는 LLM이 요청한 신뢰 불가 입력이므로 denylist를 적용한다.
      // 내부 시크릿(AGENT_RUNNER_TOKEN/LLM_PROXY_URL)이 secret 경유로 자식에 우회 주입되는 것을 막는다.
      assert.equal(env.AGENT_RUNNER_TOKEN, undefined)
    } finally {
      process.env = prev
    }
  })

  it('runBash 실행 시 AGENT_RUNNER_TOKEN이 셸에서 보이지 않음 (E2E)', async () => {
    const prev = { ...process.env }
    process.env.AGENT_RUNNER_TOKEN = 'secret-token-e2e'
    try {
      const res = await runBash({ command: 'printenv AGENT_RUNNER_TOKEN || echo SCRUBBED' }, {})
      assert.match(res.content, /SCRUBBED/)
      assert.doesNotMatch(res.content, /secret-token-e2e/)
    } finally {
      process.env = prev
    }
  })

  it('주입 프록시 활성 시 자식 env에 HTTP_PROXY/CA 주입', () => {
    const prev = { ...process.env }
    process.env.DAIOPS_INJECTION_PROXY_URL = 'http://127.0.0.1:19999'
    process.env.DAIOPS_INJECTION_CA_PATH = '/tmp/ca.crt'
    try {
      const env = buildToolEnv()
      assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:19999')
      assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:19999')
      assert.equal(env.NODE_EXTRA_CA_CERTS, '/tmp/ca.crt')
      assert.equal(env.CURL_CA_BUNDLE, '/tmp/ca.crt')
      assert.equal(env.REQUESTS_CA_BUNDLE, '/tmp/ca.crt')
      assert.match(env.NO_PROXY, /127\.0\.0\.1/)
      // 원본 설정 변수는 자식에 노출 안 됨(denylist)
      assert.equal(env.DAIOPS_INJECTION_PROXY_URL, undefined)
      assert.equal(env.DAIOPS_INJECTION_CA_PATH, undefined)
    } finally {
      process.env = prev
    }
  })

  it('주입 프록시 비활성(기본)이면 HTTP_PROXY 미주입', () => {
    const prev = { ...process.env }
    delete process.env.DAIOPS_INJECTION_PROXY_URL
    try {
      const env = buildToolEnv()
      assert.equal(env.HTTP_PROXY, undefined)
    } finally {
      process.env = prev
    }
  })
})

/** 일회용 tmp 디렉토리 생성. */
async function mkTmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runner-tools-'))
}

// ── Read ──────────────────────────────────────────────────────────────

describe('runRead', () => {
  it('파일 내용을 line|content 형식으로 반환', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'hello\nworld\n')
    const r = await runRead({ file_path: f })
    assert.ok(/^\s+1\|hello/m.test(r.content))
    assert.ok(/^\s+2\|world/m.test(r.content))
  })

  it('offset + limit로 부분 라인 반환', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'a\nb\nc\nd\ne\n')
    const r = await runRead({ file_path: f, offset: 2, limit: 2 })
    assert.ok(/^\s+2\|b/m.test(r.content))
    assert.ok(/^\s+3\|c/m.test(r.content))
    assert.ok(!/^\s+1\|a/m.test(r.content))
    assert.ok(!/^\s+4\|d/m.test(r.content))
  })

  it('상대 경로는 ctx.cwd로 해석', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'rel.txt'), 'hi')
    const r = await runRead({ file_path: 'rel.txt' }, { cwd: dir })
    assert.ok(r.content.includes('hi'))
  })

  it('없는 파일 → is_error', async () => {
    const r = await runRead({ file_path: '/nonexistent/file' })
    assert.equal(r.is_error, true)
  })

  it('디렉토리 → is_error', async () => {
    const dir = await mkTmpDir()
    const r = await runRead({ file_path: dir })
    assert.equal(r.is_error, true)
  })

  it('file_path 누락 → is_error', async () => {
    const r = await runRead({})
    assert.equal(r.is_error, true)
  })

  it('바이너리(null byte) 파일 거부', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'bin')
    await fs.writeFile(f, Buffer.from([0x00, 0x01, 0x02]))
    const r = await runRead({ file_path: f })
    assert.equal(r.is_error, true)
    assert.ok(/binary/.test(r.content))
  })
})

// ── Write ─────────────────────────────────────────────────────────────

describe('runWrite', () => {
  it('파일 새로 작성', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'out.txt')
    const r = await runWrite({ file_path: f, content: 'hi' })
    assert.equal(r.is_error, undefined)
    assert.equal(await fs.readFile(f, 'utf8'), 'hi')
  })

  it('덮어쓰기', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'out.txt')
    await fs.writeFile(f, 'old')
    await runWrite({ file_path: f, content: 'new' })
    assert.equal(await fs.readFile(f, 'utf8'), 'new')
  })

  it('부모 디렉토리 자동 생성', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a/b/c/out.txt')
    const r = await runWrite({ file_path: f, content: 'deep' })
    assert.equal(r.is_error, undefined)
    assert.equal(await fs.readFile(f, 'utf8'), 'deep')
  })

  it('content 누락 → is_error', async () => {
    const r = await runWrite({ file_path: '/tmp/x' })
    assert.equal(r.is_error, true)
  })

  it('상대 경로는 ctx.cwd로 해석', async () => {
    const dir = await mkTmpDir()
    const r = await runWrite({ file_path: 'rel.txt', content: 'x' }, { cwd: dir })
    assert.equal(r.is_error, undefined)
    assert.equal(await fs.readFile(path.join(dir, 'rel.txt'), 'utf8'), 'x')
  })
})

// ── Edit ──────────────────────────────────────────────────────────────

describe('runEdit', () => {
  it('고유한 old_string 치환', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'hello world\nbye world')
    const r = await runEdit({ file_path: f, old_string: 'hello', new_string: 'HELLO' })
    assert.equal(r.is_error, undefined)
    assert.equal(await fs.readFile(f, 'utf8'), 'HELLO world\nbye world')
  })

  it('중복 old_string + replace_all=false → is_error', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'foo foo')
    const r = await runEdit({ file_path: f, old_string: 'foo', new_string: 'bar' })
    assert.equal(r.is_error, true)
    assert.ok(/2 times/.test(r.content))
  })

  it('replace_all=true는 전체 치환', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'x x x')
    const r = await runEdit({ file_path: f, old_string: 'x', new_string: 'y', replace_all: true })
    assert.equal(r.is_error, undefined)
    assert.equal(await fs.readFile(f, 'utf8'), 'y y y')
  })

  it('없는 old_string → is_error', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'hello')
    const r = await runEdit({ file_path: f, old_string: 'absent', new_string: 'x' })
    assert.equal(r.is_error, true)
  })

  it('old === new (no-op) → is_error', async () => {
    const r = await runEdit({ file_path: '/x', old_string: 'a', new_string: 'a' })
    assert.equal(r.is_error, true)
  })
})

// ── Glob ──────────────────────────────────────────────────────────────

describe('runGlob', () => {
  it('패턴 매칭 결과 반환 + mtime desc 정렬', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'a.ts'), 'x')
    await new Promise((r) => setTimeout(r, 20))
    await fs.writeFile(path.join(dir, 'b.ts'), 'x') // newer
    await fs.writeFile(path.join(dir, 'c.js'), 'x')
    const r = await runGlob({ pattern: '*.ts', path: dir })
    assert.equal(r.is_error, undefined)
    const lines = r.content.split('\n')
    assert.equal(lines.length, 2)
    // mtime desc → b.ts가 먼저
    assert.ok(lines[0].endsWith('b.ts'))
    assert.ok(lines[1].endsWith('a.ts'))
  })

  it('매칭 없으면 "no matches"', async () => {
    const dir = await mkTmpDir()
    const r = await runGlob({ pattern: '*.absent', path: dir })
    assert.equal(r.content, 'Glob: no matches')
  })

  it('pattern 누락 → is_error', async () => {
    const r = await runGlob({})
    assert.equal(r.is_error, true)
  })
})

// ── Grep ──────────────────────────────────────────────────────────────

describe('runGrep', () => {
  it('files_with_matches 모드 (기본)', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello world')
    await fs.writeFile(path.join(dir, 'b.txt'), 'goodbye')
    const r = await runGrep({ pattern: 'hello', path: dir })
    assert.equal(r.is_error, undefined)
    assert.ok(r.content.includes('a.txt'))
    assert.ok(!r.content.includes('b.txt'))
  })

  it('content 모드 + 라인 번호', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'a.txt'), 'line1\nfoo\nline3')
    const r = await runGrep({ pattern: 'foo', path: dir, output_mode: 'content' })
    assert.ok(/a\.txt:2:foo/.test(r.content))
  })

  it('count 모드', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'a.txt'), 'foo\nfoo\nbar')
    const r = await runGrep({ pattern: 'foo', path: dir, output_mode: 'count' })
    assert.ok(/a\.txt:2/.test(r.content))
  })

  it('case-insensitive (-i)', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'a.txt'), 'Hello')
    const r = await runGrep({ pattern: 'hello', path: dir, '-i': true })
    assert.ok(r.content.includes('a.txt'))
  })

  it('glob 필터 적용', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'a.ts'), 'foo')
    await fs.writeFile(path.join(dir, 'a.js'), 'foo')
    const r = await runGrep({ pattern: 'foo', path: dir, glob: '*.ts' })
    assert.ok(r.content.includes('a.ts'))
    assert.ok(!r.content.includes('a.js'))
  })

  it('잘못된 regex → is_error', async () => {
    const r = await runGrep({ pattern: '[invalid' })
    assert.equal(r.is_error, true)
  })

  it('매칭 없음', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello')
    const r = await runGrep({ pattern: 'absent', path: dir })
    assert.equal(r.content, 'Grep: no matches')
  })

  it('node_modules / .git 자동 skip', async () => {
    const dir = await mkTmpDir()
    await fs.mkdir(path.join(dir, 'node_modules'))
    await fs.writeFile(path.join(dir, 'node_modules', 'pkg.txt'), 'foo')
    await fs.writeFile(path.join(dir, 'src.txt'), 'foo')
    const r = await runGrep({ pattern: 'foo', path: dir })
    assert.ok(r.content.includes('src.txt'))
    assert.ok(!r.content.includes('node_modules'))
  })
})

// ── Bash ──────────────────────────────────────────────────────────────

describe('runBash', () => {
  it('성공 명령 + stdout 반환', async () => {
    const r = await runBash({ command: 'echo hello' })
    assert.equal(r.is_error, undefined)
    assert.ok(r.content.includes('hello'))
    assert.ok(r.content.includes('[exit=0]'))
  })

  it('실패 종료 코드 → is_error', async () => {
    const r = await runBash({ command: 'false' })
    assert.equal(r.is_error, true)
    assert.ok(r.content.includes('[exit=1]'))
  })

  it('stderr도 같이 표시', async () => {
    const r = await runBash({ command: 'echo out; echo err >&2; exit 0' })
    assert.ok(r.content.includes('out'))
    assert.ok(r.content.includes('err'))
  })

  it('timeout → is_error', async () => {
    const r = await runBash({ command: 'sleep 5', timeout: 200 })
    assert.equal(r.is_error, true)
    assert.ok(/timeout/.test(r.content))
  })

  it('P3-a: 장시간 실행 시 onProgress로 tail 전송 (2초 주기)', async () => {
    const calls = []
    // 출력을 먼저 내고 2.4초 대기 → 2초 주기 emitter가 최소 1회 fire, tail에 출력 포함.
    const r = await runBash(
      { command: "printf 'building...\\n'; sleep 2.4", timeout: 5000 },
      { onProgress: (p) => calls.push(p) },
    )
    assert.equal(r.is_error, undefined)
    assert.ok(calls.length >= 1, `onProgress가 최소 1회 호출돼야 함 (got ${calls.length})`)
    assert.ok(calls.some((c) => c.tail.includes('building...')), 'tail에 stdout이 포함돼야 함')
    assert.ok(calls.every((c) => typeof c.elapsed_s === 'number'), 'elapsed_s는 숫자')
  })

  it('P3-a: 짧은 명령(2초 미만)은 onProgress 미발신', async () => {
    const calls = []
    await runBash({ command: 'echo quick' }, { onProgress: (p) => calls.push(p) })
    assert.equal(calls.length, 0)
  })

  it('cwd 적용', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-cwd-'))
    const r = await runBash({ command: 'pwd' }, { cwd: dir })
    // macOS는 /private/var, linux는 /tmp prefix — endsWith로 검증
    assert.ok(r.content.includes(dir) || r.content.includes(path.basename(dir)))
  })

  it('abort signal로 즉시 종료', async () => {
    const ac = new AbortController()
    const p = runBash({ command: 'sleep 5' }, { signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    const r = await p
    assert.equal(r.is_error, true)
    assert.ok(/aborted/.test(r.content))
  })

  it('command 누락 → is_error', async () => {
    const r = await runBash({})
    assert.equal(r.is_error, true)
  })
})

describe('runBash — 감싸기 고장 때 거절(대표 결정 11-26)', () => {
  it('blocking 이면 포그라운드와 백그라운드 모두 실행하지 않는다', async () => {
    const { initToolSandbox, _resetToolSandboxForTest } = await import('../tool-sandbox.js')
    const marker = path.join(os.tmpdir(), `bash-blocked-${process.pid}`)
    _resetToolSandboxForTest()
    try {
      initToolSandbox({ exists: () => true, spawn: () => ({ status: 0, stdout: 'protected=written', stderr: '' }) })
      for (const bg of [false, true]) {
        const r = await runBash({ command: `touch ${marker}`, run_in_background: bg })
        assert.equal(r.is_error, true)
        assert.match(r.content, /Bash is unavailable/)
      }
      assert.equal(await fs.access(marker).then(() => true, () => false), false)
    } finally {
      _resetToolSandboxForTest()
    }
  })
})

describe('runBash — run_in_background (잡 레지스트리)', () => {
  it('즉시 job_id 반환 + 로그·메타 파일 생성, 작업은 비동기로 완료', async () => {
    const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-jobs-'))
    const prev = process.env.AGENT_RUNNER_JOBS_DIR
    process.env.AGENT_RUNNER_JOBS_DIR = jobsDir
    try {
      const r = await runBash({ command: 'echo bg-out; echo bg-err >&2', run_in_background: true })
      assert.equal(r.is_error, undefined)
      const parsed = JSON.parse(r.content)
      assert.ok(parsed.job_id, 'job_id 반환')
      assert.equal(parsed.status, 'running')
      assert.ok(typeof parsed.pid === 'number')

      // 메타 파일 즉시 존재. 잡 폴더가 아니라 메타 폴더(<jobs>-meta)에 있다(감싼 셸이 못 쓰게)
      assert.equal(await fs.access(path.join(jobsDir, `${parsed.job_id}.meta.json`)).then(() => true, () => false), false)
      const metaRaw = await fs.readFile(path.join(`${jobsDir}-meta`, `${parsed.job_id}.meta.json`), 'utf8')
      const meta = JSON.parse(metaRaw)
      assert.equal(meta.job_id, parsed.job_id)
      assert.equal(meta.status, 'running')
      assert.equal(meta.cmd, 'echo bg-out; echo bg-err >&2')
      assert.equal(meta.log, undefined, '경로는 메타에 두지 않는다')

      // 로그 파일이 채워질 때까지 잠시 대기 (detached 비동기 완료)
      const logPath = path.join(jobsDir, `${parsed.job_id}.log`)
      let log = ''
      for (let i = 0; i < 50 && !log.includes('bg-out'); i++) {
        await new Promise((res) => setTimeout(res, 20))
        log = await fs.readFile(logPath, 'utf8').catch(() => '')
      }
      assert.ok(log.includes('bg-out'), 'stdout가 로그에 기록')
      assert.ok(log.includes('bg-err'), 'stderr도 같은 로그에 기록')
    } finally {
      if (prev === undefined) delete process.env.AGENT_RUNNER_JOBS_DIR
      else process.env.AGENT_RUNNER_JOBS_DIR = prev
      await fs.rm(jobsDir, { recursive: true, force: true })
      await fs.rm(`${jobsDir}-meta`, { recursive: true, force: true })
    }
  })

  it('run_in_background 미지정이면 기존 foreground 동작 (job_id 없음)', async () => {
    const r = await runBash({ command: 'echo fg' })
    assert.ok(r.content.includes('fg'))
    assert.ok(r.content.includes('[exit=0]'))
    assert.ok(!r.content.includes('job_id'))
  })
})

describe('BashOutput / KillShell — 백그라운드 잡 제어', () => {
  async function withJobsDir(fn) {
    const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-jobs-'))
    const prev = process.env.AGENT_RUNNER_JOBS_DIR
    process.env.AGENT_RUNNER_JOBS_DIR = jobsDir
    try {
      return await fn(jobsDir)
    } finally {
      if (prev === undefined) delete process.env.AGENT_RUNNER_JOBS_DIR
      else process.env.AGENT_RUNNER_JOBS_DIR = prev
      await fs.rm(jobsDir, { recursive: true, force: true })
      await fs.rm(`${jobsDir}-meta`, { recursive: true, force: true })
    }
  }
  /** 러너가 쓰는 자리(<jobs>-meta)에 메타를 둔다 */
  async function writeMeta(jobsDir, jobId, meta) {
    await fs.mkdir(`${jobsDir}-meta`, { recursive: true })
    await fs.writeFile(path.join(`${jobsDir}-meta`, `${jobId}.meta.json`), JSON.stringify(meta))
  }

  it('짧은 잡 완료 → BashOutput이 exit code + 로그 반환 (비0은 is_error)', async () => {
    await withJobsDir(async () => {
      const r = await runBash({ command: 'echo hi; exit 3', run_in_background: true })
      const { job_id } = JSON.parse(r.content)
      let out
      for (let i = 0; i < 80; i++) {
        out = await runBashOutput({ job_id })
        if (out.content.includes('status=exited')) break
        await new Promise((res) => setTimeout(res, 20))
      }
      assert.ok(out.content.includes('status=exited'), out.content)
      assert.ok(out.content.includes('exit=3'), out.content)
      assert.ok(out.content.includes('hi'))
      assert.equal(out.is_error, true)
    })
  })

  it('장기 잡: BashOutput running → KillShell 종료 → exited', async () => {
    await withJobsDir(async () => {
      const r = await runBash({ command: 'sleep 30', run_in_background: true })
      const { job_id } = JSON.parse(r.content)
      await new Promise((res) => setTimeout(res, 80))
      const running = await runBashOutput({ job_id })
      assert.ok(running.content.includes('status=running'), running.content)

      const killed = await runKillShell({ job_id })
      assert.ok(/stopped|already exited/.test(killed.content), killed.content)
      assert.equal(killed.is_error, undefined)

      let out
      for (let i = 0; i < 80; i++) {
        out = await runBashOutput({ job_id })
        if (out.content.includes('status=exited')) break
        await new Promise((res) => setTimeout(res, 20))
      }
      assert.ok(out.content.includes('status=exited'), out.content)
    })
  })

  // 래퍼는 sentinel 파일을 만들고 숫자를 나중에 쓴다. 그 사이에 읽으면 정상 종료가 「exit code unavailable」로 보였다(G6, 부하 시험)
  it('sentinel 이 비어 있고 잡이 살아 있으면 아직 running', async () => {
    await withJobsDir(async (jobsDir) => {
      const job_id = '00000000-0000-4000-8000-000000000001'
      await fs.writeFile(path.join(jobsDir, `${job_id}.exit`), '')
      await writeMeta(jobsDir, job_id, ({ pid: process.pid }))
      const out = await runBashOutput({ job_id })
      assert.ok(out.content.includes('status=running'), out.content)
    })
  })

  it('sentinel 이 비어 있고 잡이 없으면 exited(코드 모름)', async () => {
    await withJobsDir(async (jobsDir) => {
      const job_id = '00000000-0000-4000-8000-000000000002'
      await fs.writeFile(path.join(jobsDir, `${job_id}.exit`), '')
      await writeMeta(jobsDir, job_id, ({ pid: 2 ** 22 + 7 }))
      const out = await runBashOutput({ job_id })
      assert.ok(out.content.includes('status=exited (exit code unavailable)'), out.content)
      assert.equal(out.is_error, undefined)
    })
  })

  it('sentinel 이 없고 잡이 없으면 exited(코드 모름)', async () => {
    await withJobsDir(async (jobsDir) => {
      const job_id = '00000000-0000-4000-8000-000000000003'
      await writeMeta(jobsDir, job_id, ({ pid: 2 ** 22 + 7 }))
      const out = await runBashOutput({ job_id })
      assert.ok(out.content.includes('status=exited (exit code unavailable)'), out.content)
    })
  })

  // 보안 검토 11-26 「나」「다」: 감싼 셸은 잡 폴더에 쓸 수 있다. 거기 둔 가짜 메타, 링크, FIFO 로 러너를 부리지 못해야 한다
  it('잡 폴더에 둔 가짜 메타는 무시한다(KillShell 이 그 pid 에 신호를 보내지 않음)', async () => {
    await withJobsDir(async (jobsDir) => {
      const job_id = '00000000-0000-4000-8000-0000000000aa'
      await fs.writeFile(path.join(jobsDir, `${job_id}.meta.json`), JSON.stringify({ pid: process.pid, log: '/proc/self/environ' }))
      const k = await runKillShell({ job_id })
      assert.equal(k.is_error, true)
      assert.match(k.content, /not found/)
      assert.match((await runBashOutput({ job_id })).content, /not found/)
    })
  })

  it('메타에 적힌 log, exit 경로는 쓰지 않는다', async () => {
    await withJobsDir(async (jobsDir) => {
      const job_id = '00000000-0000-4000-8000-0000000000ab'
      await writeMeta(jobsDir, job_id, { pid: 2 ** 22 + 7, log: '/proc/self/environ', exit: '/proc/self/environ' })
      const out = await runBashOutput({ job_id })
      assert.ok(!out.content.includes('PATH='), out.content)
    })
  })

  it('로그 자리의 심볼릭 링크는 따라가지 않는다', async () => {
    await withJobsDir(async (jobsDir) => {
      const job_id = '00000000-0000-4000-8000-0000000000ac'
      const secret = path.join(jobsDir, '..', `secret-${process.pid}.txt`)
      await fs.writeFile(secret, 'TOP-SECRET')
      try {
        await writeMeta(jobsDir, job_id, { pid: 2 ** 22 + 7 })
        await fs.symlink(secret, path.join(jobsDir, `${job_id}.log`))
        const out = await runBashOutput({ job_id })
        assert.ok(!out.content.includes('TOP-SECRET'), out.content)
      } finally {
        await fs.rm(secret, { force: true })
      }
    })
  })

  it('로그 자리의 FIFO 에서 멈추지 않는다', { skip: process.platform === 'win32' }, async () => {
    await withJobsDir(async (jobsDir) => {
      const job_id = '00000000-0000-4000-8000-0000000000ad'
      await writeMeta(jobsDir, job_id, { pid: 2 ** 22 + 7 })
      const { execFileSync } = await import('node:child_process')
      execFileSync('mkfifo', [path.join(jobsDir, `${job_id}.log`), path.join(jobsDir, `${job_id}.exit`)])
      const out = await runBashOutput({ job_id })
      assert.match(out.content, /status=exited/)
    })
  })

  it('UUID 꼴이 아닌 job_id(경로 오르기 포함)는 찾지 않는다', async () => {
    await withJobsDir(async () => {
      for (const job_id of ['../jobs-meta/x', '..', 'a/b']) {
        assert.match((await runBashOutput({ job_id })).content, /not found/)
        assert.match((await runKillShell({ job_id })).content, /not found/)
      }
    })
  })

  it('KillShell 은 0, 1, 러너 자신, 러너 그룹에는 신호를 보내지 않는다', async () => {
    for (const pid of [0, 1, -1, process.pid]) assert.ok(killTargetRefusal(pid), String(pid))
    assert.equal(killTargetRefusal(4242, { selfPid: 1, groupOf: (p) => (p === 'self' ? 10 : 4242) }), null)
    assert.match(killTargetRefusal(4242, { selfPid: 1, groupOf: () => 10 }), /group/)
    await withJobsDir(async (jobsDir) => {
      const job_id = '00000000-0000-4000-8000-0000000000ae'
      await writeMeta(jobsDir, job_id, { pid: process.pid })
      const k = await runKillShell({ job_id })
      assert.equal(k.is_error, true)
      assert.match(k.content, /refusing/)
    })
  })

  it('없는 job_id → 둘 다 is_error', async () => {
    await withJobsDir(async () => {
      assert.equal((await runBashOutput({ job_id: 'nope' })).is_error, true)
      assert.equal((await runKillShell({ job_id: 'nope' })).is_error, true)
      assert.equal((await runBashOutput({})).is_error, true)
    })
  })
})

// ── index.js 디스패처 ─────────────────────────────────────────────────

describe('BUILTIN_TOOLS / runBuiltinTool / isBuiltinTool', () => {
  it('BUILTIN_TOOLS는 8종 — 파일 6 + BashOutput/KillShell', () => {
    assert.deepEqual([...BUILTIN_TOOL_NAMES], ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell'])
    for (const t of BUILTIN_TOOLS) {
      assert.ok(typeof t.name === 'string')
      assert.ok(typeof t.description === 'string')
      assert.ok(t.input_schema && typeof t.input_schema === 'object')
    }
  })

  it('isBuiltinTool', () => {
    assert.equal(isBuiltinTool('Read'), true)
    assert.equal(isBuiltinTool('BashOutput'), true)
    assert.equal(isBuiltinTool('KillShell'), true)
    assert.equal(isBuiltinTool('mcp__wiki__read'), false)
    assert.equal(isBuiltinTool('Unknown'), false)
  })

  it('runBuiltinTool로 디스패치', async () => {
    const r = await runBuiltinTool('Bash', { command: 'echo dispatched' })
    assert.ok(r.content.includes('dispatched'))
  })

  it('알 수 없는 도구 → is_error', async () => {
    const r = await runBuiltinTool('Unknown', {})
    assert.equal(r.is_error, true)
  })
})

// ── Write 안전 가드 동작 검증 ──────────────────────────────────────────

describe('Write 안전 가드 (시스템 경로 쓰기 거부)', () => {
  it('/etc 같은 시스템 경로 쓰기 거부', async () => {
    const r = await runWrite({ file_path: '/etc/test-attempt', content: 'x' })
    assert.equal(r.is_error, true)
    assert.ok(/denied prefix/.test(r.content))
  })

  it('/proc, /sys, /dev 거부', async () => {
    for (const sys of ['/proc/x', '/sys/y', '/dev/z']) {
      const r = await runWrite({ file_path: sys, content: 'x' })
      assert.equal(r.is_error, true, `${sys} should be denied`)
    }
  })

  it('DAIOPS_WRITE_SAFE_ROOT 설정 시 외부 경로 거부', async () => {
    const dir = await mkTmpDir()
    const sandbox = path.join(dir, 'sandbox')
    await fs.mkdir(sandbox)
    process.env.DAIOPS_WRITE_SAFE_ROOT = sandbox
    try {
      const outside = path.join(dir, 'outside.txt')
      const r1 = await runWrite({ file_path: outside, content: 'x' })
      assert.equal(r1.is_error, true)
      assert.ok(/DAIOPS_WRITE_SAFE_ROOT/.test(r1.content))
      // 안에는 정상 쓰기
      const inside = path.join(sandbox, 'inside.txt')
      const r2 = await runWrite({ file_path: inside, content: 'x' })
      assert.equal(r2.is_error, undefined)
    } finally {
      delete process.env.DAIOPS_WRITE_SAFE_ROOT
    }
  })
})

describe('Read 바이너리 확장자 + 이미지 분기', () => {
  it('.png은 base64 image 블록으로 반환 (vision)', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'pic.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // PNG magic
    await fs.writeFile(f, bytes)
    const r = await runRead({ file_path: f })
    assert.ok(!r.is_error)
    assert.ok(Array.isArray(r.content))
    const img = r.content.find((b) => b.type === 'image')
    assert.ok(img, 'image 블록이 있어야 함')
    assert.equal(img.source.type, 'base64')
    assert.equal(img.source.media_type, 'image/png')
    assert.equal(img.source.data, bytes.toString('base64'))
  })

  it('.bmp는 vision 미지원이라 텍스트 안내', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'old.bmp')
    await fs.writeFile(f, Buffer.from([0x42, 0x4d])) // BM magic
    const r = await runRead({ file_path: f })
    assert.equal(r.is_error, true)
    assert.ok(/does not support/.test(r.content))
  })

  it('.zip은 바이너리 확장자 거부', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.zip')
    await fs.writeFile(f, 'PK\x03\x04')
    const r = await runRead({ file_path: f })
    assert.equal(r.is_error, true)
    assert.ok(/binary extension/.test(r.content))
  })
})

describe('Read 페이지네이션 가이드', () => {
  it('offset이 총 라인보다 크면 is_error', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'a\nb\nc')
    const r = await runRead({ file_path: f, offset: 100 })
    assert.equal(r.is_error, true)
  })

  it('다음 페이지 안내 포함 (다 안 읽었을 때)', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'))
    const r = await runRead({ file_path: f, limit: 3 })
    assert.ok(/pass offset=4/.test(r.content))
  })
})

describe('Edit unified diff 반환', () => {
  it('성공 시 diff 포함', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'hello\nworld')
    const r = await runEdit({ file_path: f, old_string: 'hello', new_string: 'HELLO' })
    assert.equal(r.is_error, undefined)
    assert.ok(r.content.includes('-hello'))
    assert.ok(r.content.includes('+HELLO'))
    assert.ok(r.content.includes('--- a/'))
    assert.ok(r.content.includes('+++ b/'))
  })
})

describe('Grep 컨텍스트 라인 + 바이너리 skip', () => {
  it('-C 옵션으로 매칭 주변 노출', async () => {
    const dir = await mkTmpDir()
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'line1\nline2\nMATCH\nline4\nline5')
    const r = await runGrep({ pattern: 'MATCH', path: dir, output_mode: 'content', '-C': 1 })
    assert.ok(/2-line2/.test(r.content) || /2\|line2/.test(r.content) || r.content.includes('line2'))
    assert.ok(/MATCH/.test(r.content))
    assert.ok(r.content.includes('line4'))
  })

  it('확장자가 바이너리면 skip', async () => {
    const dir = await mkTmpDir()
    await fs.writeFile(path.join(dir, 'image.png'), 'FAKE_PNG_CONTAINING_match')
    await fs.writeFile(path.join(dir, 'src.txt'), 'src_match')
    const r = await runGrep({ pattern: 'match', path: dir, output_mode: 'files_with_matches' })
    assert.ok(r.content.includes('src.txt'))
    assert.ok(!r.content.includes('image.png'))
  })
})

describe('Bash workdir 검증', () => {
  it('존재하지 않는 cwd → is_error', async () => {
    const r = await runBash({ command: 'echo x' }, { cwd: '/this/does/not/exist/anywhere' })
    assert.equal(r.is_error, true)
    assert.ok(/cwd .* does not exist/.test(r.content))
  })
})

describe('경로 ~ 확장', () => {
  it('Read에서 ~/path를 HOME 기준으로 해석', async () => {
    const homeDir = process.env.HOME
    // 임시 파일은 HOME 안에 만들 수 없으니, /tmp가 HOME이라고 가정한 mock 대신
    // 실제 ~/.daiops-tools-test 라는 파일로 검증
    const fname = '.daiops-tools-tilde-test'
    const abs = path.join(homeDir, fname)
    await fs.writeFile(abs, 'tildeOK')
    try {
      const r = await runRead({ file_path: `~/${fname}` })
      assert.ok(r.content.includes('tildeOK'))
    } finally {
      await fs.unlink(abs).catch(() => {})
    }
  })
})

describe('러너 폴더 파일 도구 막기 (보안 검토 11/26 6-2)', async () => {
  const { isWriteDenied } = await import('./_common.js')
  const { RUNNER_READONLY_DIRS, APP_STAGING_DIRS } = await import('../tool-sandbox.js')

  it('감싼 셸이 읽기 전용으로 묶는 러너 폴더와 앱 스크립트 폴더는 Write, Edit 도 거절한다', () => {
    for (const dir of [...RUNNER_READONLY_DIRS, ...APP_STAGING_DIRS]) {
      assert.equal(isWriteDenied(dir).denied, true, dir)
      assert.equal(isWriteDenied(`${dir}/server.js`).denied, true, dir)
      assert.equal(isWriteDenied(`${dir}/jobs-meta/x.meta.json`).denied, true, dir)
    }
  })

  it('apt 가 받아 둔 .deb 와 debconf 답 자리도 거절한다(12-1)', () => {
    for (const f of ['/var/cache/apt/archives/x.deb', '/var/cache/debconf/config.dat', '/var/lib/dpkg/info/procps.postinst']) {
      assert.equal(isWriteDenied(f).denied, true, f)
    }
  })

  it('이름만 닮은 옆 폴더는 막지 않는다', () => {
    assert.equal(isWriteDenied('/workspace/.agent-runner-notes/a.md').denied, false)
    assert.equal(isWriteDenied('/opt/agent-runner2/a.js').denied, false)
  })

  it('Write 가 러너 코드를 덮지 못한다', async () => {
    const r = await runWrite({ file_path: '/opt/agent-runner/server.js', content: 'x' }, {})
    assert.equal(r.is_error, true)
    assert.match(r.content, /denied prefix '\/opt\/agent-runner'/)
  })
})
