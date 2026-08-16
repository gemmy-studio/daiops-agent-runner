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

// ── DNS TOCTOU 가드 + egress 관측 ─────────────────────────────────────
// `assertSafeMcpUrl` 은 등록된 **글자**만 본다. 도메인이 사설 IP 로 해소되는 경우
// (`evil.example.com` → `192.168.0.1`)는 요청 직전 해소 결과로 다시 판정해야 잡힌다.
//
// 관측이 같은 자리에 있는 이유: injection 프록시는 자식 셸만 지나가므로 러너 본체 fetch 로
// 나가는 MCP 호출은 아무 장부에도 안 남았다(실측 4,306건 대 0건). 상세는 cloud ADR 51 §6-e.

const { setActiveEgressObserver, EgressObserver } = await import('./proxy/egress-observer.js')
const { _resetDnsGuardCache } = await import('./mcp-client.js')

/** 호출되면 안 되는 fetch — 가드가 요청 **전에** 막는지 보려면 이게 필요하다. */
function neverFetch() {
  throw new Error('fetch가 호출되면 안 된다 — 가드가 요청 전에 막아야 한다')
}

/** 목적지만 세는 최소 관측기(보고는 하지 않는다 — canReport=false). */
function makeObserver() {
  return new EgressObserver({ logger: { info() {}, warn() {} } })
}

describe('DNS TOCTOU 가드', () => {
  // 호스트별 60초 캐시가 있어 케이스끼리 새면 판정이 섞인다.
  const fresh = () => { _resetDnsGuardCache(); setActiveEgressObserver(null) }

  const privateAddrs = [
    ['10/8', '10.0.0.5'],
    ['172.16/12', '172.20.1.1'],
    ['192.168/16', '192.168.0.1'],
    ['CGNAT 100.64/10', '100.100.0.1'],
    ['link-local(메타데이터)', '169.254.169.254'],
    ['IPv6 ULA', 'fd00::1'],
  ]
  for (const [label, address] of privateAddrs) {
    it(`도메인이 ${label} 로 해소되면 요청 전에 막는다`, async () => {
      fresh()
      const c = createMcpHttpClient(
        { name: 'evil', url: 'https://evil.example.com/mcp' },
        { fetchFn: neverFetch, lookupFn: async () => [{ address, family: address.includes(':') ? 6 : 4 }] },
      )
      await assert.rejects(() => c.listTools(), /resolves to/)
    })
  }

  it('주소 여러 개 중 하나만 사설이어도 막는다 — 라운드로빈으로 섞어 두면 통과해선 안 된다', async () => {
    fresh()
    const c = createMcpHttpClient(
      { name: 'evil', url: 'https://mixed.example.com/mcp' },
      {
        fetchFn: neverFetch,
        lookupFn: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.1.2.3', family: 4 },
        ],
      },
    )
    await assert.rejects(() => c.listTools(), /resolves to/)
  })

  it('loopback 해소는 allowLoopback opt-in 시에만 통과한다', async () => {
    fresh()
    const lookupFn = async () => [{ address: '127.0.0.1', family: 4 }]
    const blocked = createMcpHttpClient(
      { name: 'x', url: 'https://loop.example.com/mcp' },
      { fetchFn: neverFetch, lookupFn },
    )
    await assert.rejects(() => blocked.listTools(), /loopback/)

    fresh()
    let reached = false
    const allowed = createMcpHttpClient(
      { name: 'x', url: 'https://loop.example.com/mcp', allowLoopback: true },
      { fetchFn: async () => { reached = true; throw new Error('stop here') }, lookupFn },
    )
    await assert.rejects(() => allowed.listTools())
    assert.equal(reached, true, 'opt-in 했으면 가드를 지나 fetch 까지 가야 한다')
  })

  it('해소 실패는 통과시킨다(fail-open) — 일시 DNS 장애를 정책 차단으로 바꾸지 않는다', async () => {
    fresh()
    let reached = false
    const c = createMcpHttpClient(
      { name: 'x', url: 'https://nx.example.com/mcp' },
      {
        fetchFn: async () => { reached = true; throw new Error('stop here') },
        lookupFn: async () => { throw new Error('ENOTFOUND') },
      },
    )
    await assert.rejects(() => c.listTools())
    assert.equal(reached, true)
  })

  it('IP 리터럴 URL 은 DNS 를 묻지 않는다 — assertSafeMcpUrl 이 이미 판정했다', async () => {
    fresh()
    let asked = false
    // 통과해야 하는 공인 IP. 리터럴이므로 lookupFn 이 불리면 안 된다.
    const c = createMcpHttpClient(
      { name: 'x', url: 'https://93.184.216.34/mcp' },
      {
        fetchFn: async () => { throw new Error('stop here') },
        lookupFn: async () => { asked = true; return [] },
      },
    )
    await assert.rejects(() => c.listTools())
    assert.equal(asked, false)
  })
})

describe('egress 관측 — 프록시를 안 지나는 MCP 아웃바운드', () => {
  it('요청마다 목적지 호스트를 관측기에 남긴다', async () => {
    _resetDnsGuardCache()
    const observer = makeObserver()
    setActiveEgressObserver(observer)
    try {
      const c = createMcpHttpClient(
        { name: 'x', url: 'https://mcp.example.com/mcp' },
        {
          fetchFn: async () => { throw new Error('stop here') },
          lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
        },
      )
      await assert.rejects(() => c.listTools())
      const stat = observer.stats.get('mcp.example.com')
      assert.ok(stat, '목적지가 관측되지 않았다')
      assert.equal(stat.requests, 1)
      assert.equal(stat.blocked, 0)
    } finally {
      setActiveEgressObserver(null)
    }
  })

  it('가드가 막은 요청은 blocked 로 센다 — 막힌 것이 안 보이면 관측의 쓸모가 없다', async () => {
    _resetDnsGuardCache()
    const observer = makeObserver()
    setActiveEgressObserver(observer)
    try {
      const c = createMcpHttpClient(
        { name: 'x', url: 'https://evil.example.com/mcp' },
        { fetchFn: neverFetch, lookupFn: async () => [{ address: '10.0.0.5', family: 4 }] },
      )
      await assert.rejects(() => c.listTools(), /resolves to/)
      const stat = observer.stats.get('evil.example.com')
      assert.ok(stat)
      assert.equal(stat.blocked, 1)
    } finally {
      setActiveEgressObserver(null)
    }
  })

  it('관측기가 없으면 조용히 지나간다 — 테스트·로컬 dev 에서 관측 없이도 동작해야 한다', async () => {
    _resetDnsGuardCache()
    setActiveEgressObserver(null)
    let reached = false
    const c = createMcpHttpClient(
      { name: 'x', url: 'https://mcp.example.com/mcp' },
      {
        fetchFn: async () => { reached = true; throw new Error('stop here') },
        lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
      },
    )
    await assert.rejects(() => c.listTools())
    assert.equal(reached, true)
  })
})
