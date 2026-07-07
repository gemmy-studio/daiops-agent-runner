import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { decideTurnBudget } from './handler.js'

// P1 — 호출자 명시 max_turns 하드캡 vs 기본 auto-extend 결정 로직.
describe('decideTurnBudget', () => {
  const MAX_EXT = 3

  it('budget 미달이면 continue', () => {
    assert.equal(
      decideTurnBudget({ turnCount: 3, turnBudget: 6, extensionsUsed: 0, maxTurnsHard: false, maxAutoExtensions: MAX_EXT }),
      'continue',
    )
    assert.equal(
      decideTurnBudget({ turnCount: 5, turnBudget: 6, extensionsUsed: 0, maxTurnsHard: true, maxAutoExtensions: MAX_EXT }),
      'continue',
    )
  })

  it('호출자 명시(maxTurnsHard) + budget 도달 → 즉시 stop (연장 없음)', () => {
    assert.equal(
      decideTurnBudget({ turnCount: 6, turnBudget: 6, extensionsUsed: 0, maxTurnsHard: true, maxAutoExtensions: MAX_EXT }),
      'stop',
    )
  })

  it('미명시 + budget 도달 + 연장 여유 → extend (자율 작업 보호)', () => {
    assert.equal(
      decideTurnBudget({ turnCount: 50, turnBudget: 50, extensionsUsed: 0, maxTurnsHard: false, maxAutoExtensions: MAX_EXT }),
      'extend',
    )
    assert.equal(
      decideTurnBudget({ turnCount: 80, turnBudget: 80, extensionsUsed: 2, maxTurnsHard: false, maxAutoExtensions: MAX_EXT }),
      'extend',
    )
  })

  it('미명시 + 연장 소진 → stop', () => {
    assert.equal(
      decideTurnBudget({ turnCount: 140, turnBudget: 140, extensionsUsed: 3, maxTurnsHard: false, maxAutoExtensions: MAX_EXT }),
      'stop',
    )
  })

  it('하드캡은 연장 여유가 있어도 무시하고 stop (핵심 회귀 방지)', () => {
    // maxTurnsHard=true면 extensionsUsed<max여도 절대 extend하지 않는다.
    assert.equal(
      decideTurnBudget({ turnCount: 6, turnBudget: 6, extensionsUsed: 0, maxTurnsHard: true, maxAutoExtensions: MAX_EXT }),
      'stop',
    )
  })
})
