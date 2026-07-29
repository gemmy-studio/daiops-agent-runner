import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const {
  initToolCgroup,
  attachToToolCgroup,
  toolCgroupState,
  _resetToolCgroupForTest,
} = await import('./tool-cgroup.js')

describe('initToolCgroup', () => {
  beforeEach(() => _resetToolCgroupForTest())

  it('던지지 않고 state를 반환한다 (초기화 실패가 기동을 깨뜨리지 않아야 한다)', () => {
    const s = initToolCgroup()
    assert.equal(typeof s.enabled, 'boolean')
    // 비활성이면 반드시 사유가 있다 — 조용한 실패 금지.
    if (!s.enabled) assert.equal(typeof s.reason, 'string')
    else assert.equal(s.reason, null)
  })

  it('멱등이다 — 두 번 호출해도 같은 객체 상태', () => {
    const a = initToolCgroup()
    const b = initToolCgroup()
    assert.equal(a.enabled, b.enabled)
    assert.equal(a.reason, b.reason)
  })

  it('활성이면 cpu.weight가 설정돼 있다 (부분 적용 상태로 두지 않는다)', () => {
    const s = initToolCgroup()
    if (s.enabled) {
      assert.ok(Number.isInteger(s.cpuWeight))
      assert.ok(s.cpuWeight >= 1 && s.cpuWeight <= 10_000)
    } else {
      assert.equal(s.cpuWeight, null)
    }
  })

  it('활성이고 메모리 상한을 알면 high < max 순서가 유지된다', () => {
    const s = initToolCgroup()
    if (s.enabled && s.memoryHigh !== null && s.memoryMax !== null) {
      assert.ok(s.memoryHigh < s.memoryMax, 'soft(high)가 hard(max)보다 낮아야 한다')
    }
  })
})

describe('attachToToolCgroup', () => {
  beforeEach(() => _resetToolCgroupForTest())

  it('초기화 전(비활성)에는 no-op으로 false', () => {
    assert.equal(attachToToolCgroup(process.pid), false)
    assert.equal(toolCgroupState().attached, 0)
  })

  it('무효 pid는 false이고 카운터를 올리지 않는다', () => {
    initToolCgroup()
    for (const bad of [undefined, null, 0, -1, 1.5, 'abc']) {
      assert.equal(attachToToolCgroup(bad), false, String(bad))
    }
    assert.equal(toolCgroupState().attached, 0)
    assert.equal(toolCgroupState().attachFailed, 0)
  })

  it('활성 환경에서 죽은 pid 편입은 조용히 실패로 집계된다 (짧은 명령의 정상 경로)', () => {
    const s = initToolCgroup()
    if (!s.enabled) return // 쓰기 위임 없는 환경 — 이 계약은 검증 대상 아님
    // 존재하지 않을 가능성이 매우 높은 pid. ESRCH는 정상적인 실패 사유다.
    attachToToolCgroup(2_147_483_646)
    const after = toolCgroupState()
    assert.equal(after.attached + after.attachFailed, 1)
  })
})

describe('toolCgroupState', () => {
  it('vcpu·group을 함께 보고한다 (진단 시 한 번에 보이게)', () => {
    _resetToolCgroupForTest()
    initToolCgroup()
    const s = toolCgroupState()
    assert.ok(Number.isInteger(s.vcpu) && s.vcpu >= 1)
    assert.equal(s.group, '/sys/fs/cgroup/daiops-tools')
  })
})
