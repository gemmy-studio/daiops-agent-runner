import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENT_RUNNER_HEAVY_NICE = '10'
// admission 대기를 짧게 — fail-open 경로를 테스트에서 초 단위로 확인할 수 있게.
process.env.AGENT_RUNNER_ADMIT_MAX_WAIT_MS = '1200'

const mod = await import('./tool-cpu-lane.js')
const {
  buildSpawnArgs,
  nicePath,
  _resetNicePathCacheForTest,
  _resetAdmissionCountersForTest,
  admitTool,
  admissionStats,
  memoryHeadroom,
  currentMemoryBytes,
  VCPU,
  HEAVY_NICE,
  MIN_FREE_BYTES,
  MEMORY_LIMIT_BYTES,
} = mod

describe('VCPU 파생', () => {
  it('1 이상의 정수다', () => {
    assert.ok(Number.isInteger(VCPU))
    assert.ok(VCPU >= 1)
  })

  it('AGENT_RUNNER_VCPU가 os.cpus()보다 우선한다 (cloud 티어 배선 신뢰)', async () => {
    // 모듈이 부팅 1회 계산하므로 별 프로세스에서 확인한다.
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync(
      process.execPath,
      ['-e', "import('./tool-cpu-lane.js').then(m => console.log(m.VCPU))"],
      { env: { ...process.env, AGENT_RUNNER_VCPU: '3' }, encoding: 'utf-8' },
    )
    assert.equal(out.trim(), '3')
  })

  it('무효한 AGENT_RUNNER_VCPU는 무시하고 폴백한다', async () => {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync(
      process.execPath,
      ['-e', "import('./tool-cpu-lane.js').then(m => console.log(m.VCPU))"],
      { env: { ...process.env, AGENT_RUNNER_VCPU: 'abc' }, encoding: 'utf-8' },
    )
    assert.ok(Number(out.trim()) >= 1)
  })
})

describe('buildSpawnArgs', () => {
  // 이름 분기 없음 — 모든 명령이 동일하게 nice로 감싸진다.
  it('경량 명령도 nice로 래핑된다', () => {
    const np = nicePath()
    const { file, args } = buildSpawnArgs(['-c', 'ls'])
    if (np) {
      assert.equal(file, np)
      assert.deepEqual(args, ['-n', String(HEAVY_NICE), '/bin/bash', '-c', 'ls'])
    } else {
      assert.equal(file, '/bin/bash')
      assert.deepEqual(args, ['-c', 'ls'])
    }
  })

  it('종전 분류 목록의 누락·오탐 사례가 모두 동일하게 처리된다', () => {
    const np = nicePath()
    const cmds = [
      'make -j4', // 종전 누락
      './build.sh', // 종전 누락
      'tesseract scan.png out', // 종전 누락
      'pdftoppm -jpeg a.pdf out', // 종전 누락
      'git commit -m "convert to md"', // 종전 오탐(\bconvert\b)
      'node /opt/document-core/cli.js readPdf a.pdf', // 종전 정탐
      'ls -la', // 경량
    ]
    for (const cmd of cmds) {
      const { file, args } = buildSpawnArgs(['-c', cmd])
      if (np) {
        assert.equal(file, np, cmd)
        assert.deepEqual(args, ['-n', String(HEAVY_NICE), '/bin/bash', '-c', cmd], cmd)
      } else {
        assert.equal(file, '/bin/bash', cmd)
      }
    }
  })

  it('nice 부재 시 /bin/bash 폴백 (silent failure 방지)', () => {
    _resetNicePathCacheForTest()
    const np = nicePath()
    const { file } = buildSpawnArgs(['-c', 'python3 x.py'])
    assert.equal(file, np ?? '/bin/bash')
  })
})

describe('메모리 측정', () => {
  it('currentMemoryBytes는 음이 아닌 수 또는 null', () => {
    const v = currentMemoryBytes()
    assert.ok(v === null || (Number.isFinite(v) && v >= 0))
  })

  it('MIN_FREE_BYTES는 최소 256MB이고 상한의 10% 이상', () => {
    assert.ok(MIN_FREE_BYTES >= 256 * 1024 * 1024)
    if (MEMORY_LIMIT_BYTES !== null) {
      assert.ok(MIN_FREE_BYTES >= Math.floor(MEMORY_LIMIT_BYTES * 0.1))
    }
  })

  it('memoryHeadroom은 ok/freeBytes 형태를 반환한다', () => {
    const h = memoryHeadroom()
    assert.equal(typeof h.ok, 'boolean')
    assert.ok(h.freeBytes === null || Number.isFinite(h.freeBytes))
  })
})

describe('admitTool', () => {
  beforeEach(() => _resetAdmissionCountersForTest())

  const free = () => ({ ok: true, freeBytes: 2 * 1024 * 1024 * 1024 })
  const tight = () => ({ ok: false, freeBytes: 10 * 1024 * 1024 })
  const unavailable = () => ({ ok: true, freeBytes: null })

  it('여유가 있으면 즉시 통과하고 대기가 0이다', async () => {
    const r = await admitTool({ readHeadroom: free })
    assert.deepEqual(
      { admitted: r.admitted, waitedMs: r.waitedMs, forced: r.forced },
      { admitted: true, waitedMs: 0, forced: false },
    )
    assert.equal(admissionStats().admitted, 1)
    assert.equal(admissionStats().waited, 0)
  })

  it('측정 불가(freeBytes=null)는 no-op으로 즉시 통과 — fail-open', async () => {
    const r = await admitTool({ readHeadroom: unavailable })
    assert.equal(r.admitted, true)
    assert.equal(r.waitedMs, 0)
    assert.equal(admissionStats().unavailable, 1)
  })

  it('여유가 없으면 대기하고, 회복되면 통과한다 (pacing)', async () => {
    let calls = 0
    const recovering = () => (++calls >= 3 ? free() : tight())
    const r = await admitTool({ readHeadroom: recovering })
    assert.equal(r.admitted, true)
    assert.equal(r.forced, false)
    assert.ok(r.waitedMs > 0, '대기가 있어야 한다')
    assert.equal(admissionStats().waited, 1)
    assert.equal(admissionStats().forced, 0)
  })

  it('회복되지 않으면 상한 대기 후 통과한다 (forced, fail-open)', async () => {
    const r = await admitTool({ readHeadroom: tight })
    assert.equal(r.admitted, true, '거절하지 않는다 — 명령의 실제 메모리 요구를 알 수 없다')
    assert.equal(r.forced, true)
    assert.ok(r.waitedMs >= 1200, `대기 상한(1200ms) 이상: ${r.waitedMs}`)
    assert.equal(admissionStats().forced, 1)
  })

  it('대기 중 abort되면 admitted=false로 끝난다', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const r = await admitTool({ readHeadroom: tight, signal: ac.signal })
    assert.equal(r.admitted, false)
    assert.ok(r.waitedMs < 1200, '상한을 기다리지 않고 즉시 중단')
  })

  it('여유가 있으면 abort 신호가 이미 서 있어도 통과한다 (대기 진입 전)', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await admitTool({ readHeadroom: free, signal: ac.signal })
    assert.equal(r.admitted, true)
  })

  it('admissionStats가 파생 상수를 함께 보고한다', () => {
    const s = admissionStats()
    assert.equal(s.vcpu, VCPU)
    assert.equal(s.minFreeBytes, MIN_FREE_BYTES)
    assert.equal(s.memoryLimitBytes, MEMORY_LIMIT_BYTES)
    for (const k of ['admitted', 'waited', 'forced', 'unavailable']) {
      assert.equal(typeof s[k], 'number', k)
    }
  })
})
