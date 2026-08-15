/**
 * ADR 51 잔여 하드닝 — SSRF 사설 대역 · 응답 바이트 상한 · 도구 설명 상한 · per-call 결과 상한.
 *
 * 기존 `mcp-client.test.js`(계약·마스킹)와 분리한 이유: 여기 넣는 것들은 전부 **상대가 크기·주소를
 * 정하는 입력에 대한 방어**라, 계약 테스트와 실패 시 읽는 방향이 다르다.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP = path.join(os.tmpdir(), `mcp-harden-test-${process.pid}`)
process.env.AGENT_RUNNER_OFFLOAD_DIR = TMP

const { createMcpHttpClient, createMcpToolRegistry } = await import('./mcp-client.js')
const { enforceMcpResultCap, sweepOffloadDir, _resetOffloadSweepForTest, OFFLOAD_MARKER } =
  await import('./offload.js')

// ── SSRF: 사설 대역 ────────────────────────────────────────────────────
// MCP 규격 Security Best Practices 가 클라이언트에 SHOULD 로 요구하는 목록.
// 종전 가드는 메타데이터·loopback 만 봐서 `https://10.0.0.5/mcp` 가 통과했다.

describe('assertSafeMcpUrl — 사설 대역 차단', () => {
  const blocked = [
    'https://10.0.0.5/mcp',
    'https://172.16.0.1/mcp',
    'https://172.31.255.254/mcp',
    'https://192.168.1.1/mcp',
    'https://100.64.0.1/mcp', // CGNAT
    'https://[fc00::1]/mcp', // IPv6 ULA
    'https://[fe80::1]/mcp', // IPv6 link-local
    // IPv4-mapped IPv6. ⚠️ URL 파서가 `::ffff:a00:1` 로 **압축**하므로 점 표기만 보면 놓친다.
    'https://[::ffff:10.0.0.1]/mcp',
    'https://[::ffff:192.168.1.1]/mcp',
    // 규격이 경고한 인코딩 트릭들 — 실제로는 WHATWG URL 이 `127.0.0.1` 로 정규화해
    // loopback 분기가 잡는다. 어느 분기가 잡든 **막히는 것**이 계약이다.
    'https://2130706433/mcp',
    'https://0x7f000001/mcp',
    'https://0177.0.0.1/mcp',
  ]
  for (const url of blocked) {
    it(`거절: ${url}`, () => {
      assert.throws(
        () => createMcpHttpClient({ name: 's', url }, { fetchFn: async () => new Response('') }),
        /private network not allowed|blocked URL host/,
      )
    })
  }

  const allowed = [
    'https://mcp.partner.example.com/mcp',
    'https://8.8.8.8/mcp', // 공인 IP 리터럴은 이 가드의 대상이 아니다(cloud 가 별도로 금지한다)
    'https://172.15.0.1/mcp', // 172.16/12 경계 바깥
    'https://172.32.0.1/mcp',
    'https://192.169.0.1/mcp',
    // 선행 0 은 파서가 8진수로 해석해 `8.0.0.1`(공인)이 된다. 우리가 판정할 대상이 아니다 —
    // fetch 가 실제로 가는 곳이 8.0.0.1 이기 때문이다(실측으로 확인한 정규화 동작).
    'https://010.0.0.1/mcp',
  ]
  for (const url of allowed) {
    it(`통과: ${url}`, () => {
      assert.doesNotThrow(() =>
        createMcpHttpClient({ name: 's', url }, { fetchFn: async () => new Response('') }),
      )
    })
  }

  it('loopback opt-in(allowLoopback)은 그대로 동작한다 — 로컬 지식 MCP 서버 경로', () => {
    assert.doesNotThrow(() =>
      createMcpHttpClient(
        { name: 'local', url: 'http://127.0.0.1:9100', allowLoopback: true },
        { fetchFn: async () => new Response('') },
      ),
    )
  })
})

// ── 응답 바이트 상한 ───────────────────────────────────────────────────

describe('readBodyWithLimit — 응답 바이트 상한', () => {
  /** 상한을 넘는 본문을 주는 서버. content-length 유무로 두 경로를 나눠 본다. */
  function bigBodyFetch({ declareLength }) {
    return async () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { x: 'A'.repeat(200) } })
      const headers = { 'content-type': 'application/json' }
      if (declareLength) headers['content-length'] = String(10_000)
      return new Response(body, { status: 200, headers })
    }
  }

  it('content-length 가 상한을 넘으면 한 바이트도 읽기 전에 거절한다', async () => {
    process.env.AGENT_RUNNER_MCP_MAX_RESPONSE_BYTES = '1000'
    const { createMcpHttpClient: fresh } = await import(`./mcp-client.js?len=${Date.now()}`)
    const c = fresh({ name: 's', url: 'https://x.example.com/mcp' }, { fetchFn: bigBodyFetch({ declareLength: true }) })
    await assert.rejects(() => c.listTools(), /response too large/)
    delete process.env.AGENT_RUNNER_MCP_MAX_RESPONSE_BYTES
  })

  it('content-length 가 없어도 누적 길이로 잡는다 (chunked)', async () => {
    process.env.AGENT_RUNNER_MCP_MAX_RESPONSE_BYTES = '50'
    const { createMcpHttpClient: fresh } = await import(`./mcp-client.js?nolen=${Date.now()}`)
    const c = fresh({ name: 's', url: 'https://x.example.com/mcp' }, { fetchFn: bigBodyFetch({ declareLength: false }) })
    await assert.rejects(() => c.listTools(), /response too large/)
    delete process.env.AGENT_RUNNER_MCP_MAX_RESPONSE_BYTES
  })

  it('상한 이하 응답은 정상 파싱된다 — 방어가 정상 경로를 막지 않는다', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 't' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const c = createMcpHttpClient({ name: 's', url: 'https://x.example.com/mcp' }, { fetchFn })
    const tools = await c.listTools()
    assert.equal(tools.length, 1)
  })
})

// ── 도구 설명 상한 ─────────────────────────────────────────────────────

describe('도구 설명 상한 (2048자)', () => {
  it('긴 설명은 잘리고 표시가 붙는다 — 프롬프트에 실리는 크기를 상대가 정하게 두지 않는다', async () => {
    const long = 'D'.repeat(5000)
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [{ name: 'big', description: long, inputSchema: { type: 'object' } }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const reg = await createMcpToolRegistry([{ name: 'srv', url: 'https://x.example.com/mcp' }], { fetchFn })
    const desc = reg.tools[0].description
    assert.ok(desc.length < long.length)
    assert.ok(desc.endsWith('… [truncated]'))
    assert.ok(desc.startsWith('DDD'))
  })

  it('짧은 설명은 그대로 둔다', async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [{ name: 'small', description: '짧은 설명', inputSchema: { type: 'object' } }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const reg = await createMcpToolRegistry([{ name: 'srv', url: 'https://x.example.com/mcp' }], { fetchFn })
    assert.equal(reg.tools[0].description, '짧은 설명')
  })
})

// ── per-call 결과 상한 ─────────────────────────────────────────────────

describe('enforceMcpResultCap — per-call 상한', () => {
  before(async () => { await fs.mkdir(TMP, { recursive: true }) })
  after(async () => { await fs.rm(TMP, { recursive: true, force: true }) })

  it('상한 이하는 손대지 않는다', async () => {
    const r = { content: 'x'.repeat(100) }
    assert.equal(await enforceMcpResultCap(r, { maxChars: 1000 }), false)
    assert.equal(r.content.length, 100)
  })

  it('상한 초과는 파일로 빼고 프리뷰 + 안내를 남긴다', async () => {
    const r = { content: 'B'.repeat(50_000) }
    assert.equal(await enforceMcpResultCap(r, { maxChars: 1000, toolName: 'mcp__srv__list' }), true)
    assert.ok(r.content.startsWith(OFFLOAD_MARKER))
    assert.ok(r.content.length < 50_000)
    // 문구가 상한 자체보다 중요하다 — 다시 통째로 읽는 대신 좁혀 묻는 방향을 줘야 한다.
    assert.ok(r.content.includes('페이지네이션'))
    assert.ok(r.content.includes('mcp__srv__list'))
    // 원문 경로가 있어야 복구가 가능하다.
    assert.ok(/\.txt/.test(r.content))
  })

  it('이미 오프로드된 결과는 다시 처리하지 않는다 (per-turn 패스와 멱등)', async () => {
    const r = { content: `${OFFLOAD_MARKER} 이미 처리됨${'C'.repeat(5000)}` }
    assert.equal(await enforceMcpResultCap(r, { maxChars: 100 }), false)
  })

  it('이미지 블록이 있으면 건드리지 않는다 — base64를 굳히면 재열람 경로가 죽는다', async () => {
    const r = {
      content: [
        { type: 'text', text: 'D'.repeat(50_000) },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      ],
    }
    assert.equal(await enforceMcpResultCap(r, { maxChars: 100 }), false)
  })
})

// ── 오프로드 파일 정리 ─────────────────────────────────────────────────

describe('sweepOffloadDir — 보관 기간 정리', () => {
  before(async () => { await fs.mkdir(TMP, { recursive: true }) })
  after(async () => { await fs.rm(TMP, { recursive: true, force: true }) })

  it('보관 기간이 지난 파일만 지운다', async () => {
    const oldFile = path.join(TMP, 'tool-result-old.txt')
    const newFile = path.join(TMP, 'tool-result-new.txt')
    const other = path.join(TMP, 'unrelated.log')
    await fs.writeFile(oldFile, 'old')
    await fs.writeFile(newFile, 'new')
    await fs.writeFile(other, 'keep')

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(oldFile, eightDaysAgo, eightDaysAgo)

    _resetOffloadSweepForTest()
    const removed = await sweepOffloadDir()

    assert.equal(removed, 1)
    await assert.rejects(() => fs.stat(oldFile))
    assert.ok(await fs.stat(newFile))
    // 우리가 만들지 않은 파일은 건드리지 않는다.
    assert.ok(await fs.stat(other))
  })

  it('쿨다운 안에서는 다시 훑지 않는다 — 매 오프로드마다 디렉토리를 읽지 않는다', async () => {
    _resetOffloadSweepForTest()
    await sweepOffloadDir()
    const old = path.join(TMP, 'tool-result-old2.txt')
    await fs.writeFile(old, 'x')
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(old, past, past)

    assert.equal(await sweepOffloadDir(), 0) // 쿨다운 — 지우지 않는다
    assert.ok(await fs.stat(old))
  })
})
