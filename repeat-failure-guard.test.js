import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RepeatFailureGuard,
  REPEAT_FAILURE_THRESHOLD,
  NO_PROGRESS_FAILURE_THRESHOLD,
} from './repeat-failure-guard.js'

describe('RepeatFailureGuard.signature', () => {
  it('같은 도구+입력은 같은 서명', () => {
    const a = RepeatFailureGuard.signature('Bash', { command: 'ls' })
    const b = RepeatFailureGuard.signature('Bash', { command: 'ls' })
    assert.equal(a, b)
  })

  it('입력이 다르면 서명도 다름', () => {
    const a = RepeatFailureGuard.signature('Bash', { command: 'ls' })
    const b = RepeatFailureGuard.signature('Bash', { command: 'pwd' })
    assert.notEqual(a, b)
  })

  it('직렬화 불가(순환 참조) 입력도 throw 없이 처리', () => {
    const circular = {}
    circular.self = circular
    assert.doesNotThrow(() => RepeatFailureGuard.signature('Bash', circular))
  })
})

describe('RepeatFailureGuard — 같은 (도구,입력) 반복 실패', () => {
  it('임계값 미만이면 차단하지 않음', () => {
    const g = new RepeatFailureGuard()
    const input = { command: 'libreoffice --convert-to pdf x.hwpx' }
    for (let i = 0; i < REPEAT_FAILURE_THRESHOLD - 1; i++) {
      g.record('Bash', input, false)
    }
    assert.equal(g.shouldBlock('Bash', input), null)
  })

  it('임계값 도달 시 사유 문자열 반환', () => {
    const g = new RepeatFailureGuard()
    const input = { command: 'libreoffice --convert-to pdf x.hwpx' }
    for (let i = 0; i < REPEAT_FAILURE_THRESHOLD; i++) {
      g.record('Bash', input, false)
    }
    const reason = g.shouldBlock('Bash', input)
    assert.ok(reason && reason.includes('Bash'))
    assert.ok(reason.includes('실패'))
  })

  it('성공이 끼면 연속 카운터만 리셋(서명 누적은 유지)', () => {
    const g = new RepeatFailureGuard()
    const input = { command: 'x' }
    g.record('Bash', input, false)
    g.record('Bash', input, true) // 성공
    g.record('Bash', input, false)
    // 서명 실패는 2회뿐 → 아직 차단 안 됨
    assert.equal(g.shouldBlock('Bash', input), null)
  })

  it('서로 다른 서명은 독립적으로 집계', () => {
    const g = new RepeatFailureGuard()
    for (let i = 0; i < REPEAT_FAILURE_THRESHOLD; i++) {
      g.record('Bash', { command: 'a' }, false)
    }
    // 'a'는 차단되지만 'b'는 깨끗
    assert.ok(g.shouldBlock('Bash', { command: 'a' }))
    // 단, 연속 실패가 누적됐으므로 no-progress 영향은 별도 — 여기선 3회라 미달
    assert.equal(g.consecutive, REPEAT_FAILURE_THRESHOLD)
  })
})

describe('RepeatFailureGuard — 무진전 연속 실패(입력이 달라도)', () => {
  it('입력을 바꿔가며 연속 실패가 임계값에 도달하면 차단', () => {
    const g = new RepeatFailureGuard()
    // file → python → libreoffice … 처럼 매번 다른 입력으로 전부 실패하는 HWP 루프 재현
    for (let i = 0; i < NO_PROGRESS_FAILURE_THRESHOLD; i++) {
      g.record('Bash', { command: `attempt-${i}` }, false)
    }
    // 다음 호출은 어떤 (새) 입력이든 무진전으로 차단돼야 함
    const reason = g.shouldBlock('Bash', { command: 'attempt-new' })
    assert.ok(reason && reason.includes('진전'))
  })

  it('중간에 성공하면 연속 카운터 리셋 → 무진전 미발동', () => {
    const g = new RepeatFailureGuard()
    for (let i = 0; i < NO_PROGRESS_FAILURE_THRESHOLD - 1; i++) {
      g.record('Bash', { command: `a-${i}` }, false)
    }
    g.record('Bash', { command: 'ok' }, true) // 성공 → 리셋
    g.record('Bash', { command: 'b' }, false)
    assert.equal(g.shouldBlock('Bash', { command: 'c' }), null)
  })
})
