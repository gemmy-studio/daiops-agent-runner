import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { collectRuntimeProbe, parseCpuMax, detectCgroupVersion, probeCgroupWritable } = await import(
  './runtime-probe.js'
)

describe('parseCpuMax', () => {
  it('quota/period를 vCPU로 환산한다', () => {
    assert.equal(parseCpuMax('100000 100000'), 1)
    assert.equal(parseCpuMax('200000 100000'), 2)
    assert.equal(parseCpuMax('400000 100000'), 4)
    assert.equal(parseCpuMax('50000 100000'), 0.5)
  })

  it("무제한('max')·빈값·깨진 값은 null — 호출자가 다른 근거로 폴백해야 한다", () => {
    assert.equal(parseCpuMax('max 100000'), null)
    assert.equal(parseCpuMax(''), null)
    assert.equal(parseCpuMax(null), null)
    assert.equal(parseCpuMax('abc def'), null)
    assert.equal(parseCpuMax('100000 0'), null)
    assert.equal(parseCpuMax('-100 100000'), null)
  })
})

describe('collectRuntimeProbe', () => {
  it('던지지 않고, 스키마의 모든 키를 반환한다 (관측이 가용성을 해쳐선 안 됨)', () => {
    const p = collectRuntimeProbe()
    for (const k of [
      'osCpus',
      'envVcpu',
      'cgroupVersion',
      'cpuMax',
      'cpuMaxVcpu',
      'cpuWeight',
      'memoryMax',
      'memoryCurrent',
      'cgroupWritable',
      'totalMemMb',
    ]) {
      assert.ok(k in p, `${k} 누락`)
    }
    assert.equal(typeof p.cgroupWritable, 'boolean')
  })

  it('AGENT_RUNNER_VCPU를 숫자로 읽고, 무효값은 null', () => {
    const orig = process.env.AGENT_RUNNER_VCPU
    try {
      process.env.AGENT_RUNNER_VCPU = '4'
      assert.equal(collectRuntimeProbe().envVcpu, 4)
      process.env.AGENT_RUNNER_VCPU = 'abc'
      assert.equal(collectRuntimeProbe().envVcpu, null)
      process.env.AGENT_RUNNER_VCPU = '0'
      assert.equal(collectRuntimeProbe().envVcpu, null)
      delete process.env.AGENT_RUNNER_VCPU
      assert.equal(collectRuntimeProbe().envVcpu, null)
    } finally {
      if (orig === undefined) delete process.env.AGENT_RUNNER_VCPU
      else process.env.AGENT_RUNNER_VCPU = orig
    }
  })

  it('cgroup 미마운트 환경에서도 판별이 null/false로 수렴한다', () => {
    // 개발 머신(WSL·macOS)에서는 v2일 수도 null일 수도 있다 — 어느 쪽이든 값 타입만 검증한다.
    const v = detectCgroupVersion()
    assert.ok(v === 'v2' || v === 'v1' || v === null)
    assert.equal(typeof probeCgroupWritable(), 'boolean')
  })
})
