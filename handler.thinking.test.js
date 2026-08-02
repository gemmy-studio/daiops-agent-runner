import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseThinkingParam } from './handler.js'

// E-1 — cloud가 보낸 thinking effort 오버라이드의 파라미터 정규화.
// 핵심 회귀: 미지정이 undefined로 떨어져야 buildThinkingOptions가 기본 medium을 쓰고
// 구버전 cloud(이 필드를 보내지 않는다)와 동작이 같아진다.
describe('parseThinkingParam', () => {
  it('미지정·비객체는 undefined (구버전 cloud 하위호환)', () => {
    for (const raw of [undefined, null, '', 'low', 3, true, []]) {
      assert.equal(parseThinkingParam(raw), undefined)
    }
  })

  it('effort가 문자열이면 통과', () => {
    assert.deepEqual(parseThinkingParam({ effort: 'low' }), { effort: 'low' })
    assert.deepEqual(parseThinkingParam({ effort: 'medium' }), { effort: 'medium' })
  })

  it('effort가 없거나 문자열이 아니면 undefined', () => {
    assert.equal(parseThinkingParam({}), undefined)
    assert.equal(parseThinkingParam({ effort: '' }), undefined)
    assert.equal(parseThinkingParam({ effort: 3 }), undefined)
    assert.equal(parseThinkingParam({ effort: null }), undefined)
    assert.equal(parseThinkingParam({ effort: { level: 'low' } }), undefined)
  })

  it('미지의 effort 문자열도 통과시킨다 — 판정은 buildThinkingOptions 한 곳에서만 한다', () => {
    // 여기서 허용 목록을 복제하면 cloud가 새 칸을 쓸 때 러너 재배포가 필요해진다.
    // turn-manager.test.js가 '미지의 effort → medium' 을 별도로 검증한다.
    assert.deepEqual(parseThinkingParam({ effort: 'turbo' }), { effort: 'turbo' })
  })

  it('추가 필드는 버리고 effort만 남긴다', () => {
    assert.deepEqual(parseThinkingParam({ effort: 'low', type: 'adaptive', budget_tokens: 999 }), {
      effort: 'low',
    })
  })
})
