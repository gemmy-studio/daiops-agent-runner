import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 테스트 격리: 오프로드 디렉토리를 임시 경로로 override 후 import (모듈 로드 시 상수 캡처).
const TMP = path.join(os.tmpdir(), `offload-test-${process.pid}`)
process.env.AGENT_RUNNER_OFFLOAD_DIR = TMP

const { enforceTurnResultBudget, truncateMiddle, TURN_RESULT_BUDGET_CHARS, OFFLOAD_MARKER } =
  await import('./offload.js')

describe('truncateMiddle', () => {
  it('maxChars 이하면 원본 유지', () => {
    assert.equal(truncateMiddle('short', 100), 'short')
  })
  it('초과 시 head+tail 프리뷰 + 생략 표기', () => {
    const text = 'A'.repeat(5000)
    const out = truncateMiddle(text, 1000)
    assert.ok(out.length < text.length)
    assert.ok(out.includes('중간') && out.includes('생략'))
    assert.ok(out.startsWith('A'))
    assert.ok(out.endsWith('A'))
  })
  it('비문자열 방어', () => {
    assert.equal(truncateMiddle(null, 100), null)
  })
})

describe('enforceTurnResultBudget', () => {
  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true }).catch(() => {})
  })

  it('예산 이내면 no-op', async () => {
    const results = [{ type: 'tool_result', tool_use_id: 't0', content: 'small' }]
    const n = await enforceTurnResultBudget(results)
    assert.equal(n, 0)
    assert.equal(results[0].content, 'small')
  })

  it('예산 초과 시 큰 것부터 오프로드 + 프리뷰 치환 + 파일 저장', async () => {
    const big = 'B'.repeat(TURN_RESULT_BUDGET_CHARS + 10_000)
    const results = [
      { type: 'tool_result', tool_use_id: 't0', content: big },
      { type: 'tool_result', tool_use_id: 't1', content: 'tiny' },
    ]
    let notified = null
    const n = await enforceTurnResultBudget(results, { onOffload: (i) => { notified = i } })
    assert.equal(n, 1)
    // 큰 것이 프리뷰+마커로 치환됨.
    assert.ok(results[0].content.length < big.length)
    assert.ok(results[0].content.includes(OFFLOAD_MARKER))
    // 작은 것은 그대로.
    assert.equal(results[1].content, 'tiny')
    // 콜백 호출.
    assert.equal(notified.offloaded, 1)
    // 저장 파일에 원본 전체가 있음 (경로는 마커 뒤 텍스트에서 추출).
    const m = results[0].content.match(/Read\("([^"]+)"\)/)
    assert.ok(m, 'saved path should be in note')
    const saved = await fs.readFile(m[1], 'utf-8')
    assert.equal(saved.length, big.length)
  })

  it('작은 결과 여러 개는 오프로드하지 않음(개별 최소 미만)', async () => {
    // 합계는 예산 초과지만 개별은 OFFLOAD_SINGLE_MIN_CHARS 미만 → 손대지 않음.
    const chunk = 'C'.repeat(5000)
    const results = Array.from({ length: 50 }, (_, i) => ({
      type: 'tool_result', tool_use_id: `t${i}`, content: chunk,
    }))
    const n = await enforceTurnResultBudget(results)
    assert.equal(n, 0)
  })

  it('이미지 블록 포함 결과는 오프로드 대상에서 제외', async () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(9000) } }
    const big = 'B'.repeat(TURN_RESULT_BUDGET_CHARS + 10_000)
    const results = [
      { type: 'tool_result', tool_use_id: 'img', content: [{ type: 'text', text: 'x' }, img] },
      { type: 'tool_result', tool_use_id: 'txt', content: big },
    ]
    const n = await enforceTurnResultBudget(results)
    assert.equal(n, 1) // 텍스트만 오프로드
    assert.ok(Array.isArray(results[0].content)) // 이미지 결과는 배열 그대로
  })
})
