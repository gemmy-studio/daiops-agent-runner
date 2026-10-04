import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UNSAFE_MEMORY_CONTENT_GUIDANCE } from './handler.js'
import { isMemoryEditAction } from './tools/memory-edit.js'

// 회귀 R2 3-b: 저장 검사에 걸린 remember·revise 를 「잠시 후 다시 시도」로 안내하면 모델이 같은 문장을 재시도한다.
describe('저장 검사 거부 안내', () => {
  it('다시 시도하라고 하지 않는다', () => {
    assert.ok(!/잠시 후 다시/.test(UNSAFE_MEMORY_CONTENT_GUIDANCE))
    assert.match(UNSAFE_MEMORY_CONTENT_GUIDANCE, /다시 시도하지 말고/)
  })
  it('revise 결과 어휘에 blocked 가 있다', () => {
    assert.equal(isMemoryEditAction('blocked'), true)
  })
})
