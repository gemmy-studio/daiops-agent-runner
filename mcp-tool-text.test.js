/**
 * 외부 MCP 도구 정화 · 지문 — 클라우드(`src/lib/security/mcp-tool-text.ts`)와 같은 시험 자료를 읽는다.
 * 이 파일이 실패하면 클라우드 승인 지문과 러너 지문이 갈린 것이다(모든 외부 서버가 「바뀜」으로 막힌다).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeMcpTools, fingerprintMcpTools, diffMcpToolFingerprints } from './mcp-tool-text.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const { vectors } = JSON.parse(readFileSync(path.join(dir, 'test-fixtures', 'mcp-tool-fingerprint-vectors.json'), 'utf8'))

describe('normalizeMcpTools · fingerprintMcpTools (클라우드와 같은 시험 자료)', () => {
  for (const v of vectors) {
    it(v.name, () => {
      const { tools, dropped } = normalizeMcpTools(v.input)
      assert.deepEqual(tools, v.expected.tools)
      assert.deepEqual(dropped, v.expected.dropped)
      assert.deepEqual(fingerprintMcpTools(tools), v.expected.fingerprints)
    })
  }
})

describe('diffMcpToolFingerprints', () => {
  const pinned = { a: '1', b: '2' }
  it('설명이 바뀌거나 도구가 늘면 막는다', () => {
    assert.equal(diffMcpToolFingerprints(pinned, { a: '1', b: '9' }).blocked, true)
    assert.equal(diffMcpToolFingerprints(pinned, { a: '1', b: '2', c: '3' }).blocked, true)
  })
  it('빠지기만 하면 막지 않는다', () => {
    assert.deepEqual(diffMcpToolFingerprints(pinned, { a: '1' }), { added: [], changed: [], removed: ['b'], blocked: false })
  })
})
