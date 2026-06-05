import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createMcpHttpClient,
  createMcpToolRegistry,
  normalizeMcpToolResult,
  maskSensitiveHeaders,
  maskTokensInText,
  maskSecretValues,
  isMcpToolName,
} from './mcp-client.js'

// ── 모의 MCP 서버 (JSON-RPC over HTTP) ────────────────────────────────

/**
 * 단일 서버를 흉내내는 mock fetchFn 빌더.
 * routes: { [method]: handler(params, headers) => result | { error: { code, message } } }
 * 호출 로그를 calls 배열에 기록.
 */
function mockMcpServer({ routes, url = 'http://mock', onCall } = {}) {
  const calls = []
  async function fakeFetch(reqUrl, init) {
    const headers = init?.headers ?? {}
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ url: reqUrl, headers, body, signal: init?.signal })
    if (onCall) onCall({ url: reqUrl, headers, body })

    if (reqUrl !== url) {
      return new Response('not found', { status: 404 })
    }
    if (!body || body.jsonrpc !== '2.0') {
      return new Response('bad request', { status: 400 })
    }
    // notifications/* 는 응답 안 받음 (단순히 200 빈 응답)
    if (body.method && body.method.startsWith('notifications/')) {
      return new Response('', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const handler = routes?.[body.method]
    if (!handler) {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    let result
    try {
      result = await handler(body.params, headers)
    } catch (err) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (result && typeof result === 'object' && 'error' in result) {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, error: result.error }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { fetchFn: fakeFetch, calls }
}

// ── 마스킹 ────────────────────────────────────────────────────────────

describe('maskSensitiveHeaders', () => {
  it('Authorization/x-api-key 등 민감 헤더는 *** 로 치환', () => {
    const out = maskSensitiveHeaders({
      Authorization: 'Bearer abc',
      'X-Api-Key': 'sk-ant-xxx',
      'x-trace-id': 'trace-1',
    })
    assert.equal(out.Authorization, '***')
    assert.equal(out['X-Api-Key'], '***')
    assert.equal(out['x-trace-id'], 'trace-1')
  })

  it('대소문자 무관', () => {
    const out = maskSensitiveHeaders({ COOKIE: 'session=1' })
    assert.equal(out.COOKIE, '***')
  })

  it('undefined도 안전', () => {
    assert.deepEqual(maskSensitiveHeaders(undefined), {})
  })

  it('원본 객체는 변형하지 않음', () => {
    const src = { Authorization: 'Bearer abc' }
    maskSensitiveHeaders(src)
    assert.equal(src.Authorization, 'Bearer abc')
  })
})

describe('maskTokensInText', () => {
  it('Bearer 토큰 마스킹', () => {
    assert.equal(maskTokensInText('failed: Bearer abc123XYZ'), 'failed: ***')
  })

  it('Anthropic API key 마스킹', () => {
    assert.equal(
      maskTokensInText('key=sk-ant-api03-abcdefXYZ_-+/=qwerty'),
      'key=***',
    )
  })

  it('JWT 마스킹', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'
    assert.equal(maskTokensInText(`token: ${jwt}`), 'token: ***')
  })

  it('non-string도 안전', () => {
    assert.equal(maskTokensInText(undefined), '')
    assert.equal(maskTokensInText({ a: 1 }), '[object Object]')
  })
})

describe('maskSecretValues', () => {
  it('활성 secret 값을 정확히 마스킹 (echo $KEY 출력)', () => {
    const secrets = new Map([['STRIPE_API_KEY', 'rk_live_abcDEF123']])
    assert.equal(
      maskSecretValues('result: rk_live_abcDEF123\n', secrets.values()),
      'result: ***\n',
    )
  })

  it('토큰 모양과 무관한 임의 값도 마스킹 (DB 비밀번호 등)', () => {
    const secrets = new Map([['DB_PASSWORD', 's3cr3t-p@ss word!']])
    assert.equal(
      maskSecretValues('PGPASSWORD=s3cr3t-p@ss word!', secrets.values()),
      'PGPASSWORD=***',
    )
  })

  it('동일 값이 여러 번 나와도 모두 치환', () => {
    const secrets = new Map([['K', 'TOKENVAL']])
    assert.equal(maskSecretValues('TOKENVAL x TOKENVAL', secrets.values()), '*** x ***')
  })

  it('정규식 메타문자가 든 값도 리터럴로 매칭', () => {
    const secrets = new Map([['K', 'a.b*c+(d)']])
    assert.equal(maskSecretValues('val=a.b*c+(d)', secrets.values()), 'val=***')
    // 메타문자가 정규식으로 해석됐다면 'axbyc...'도 매칭됐을 것 — 그러지 않음을 확인
    assert.equal(maskSecretValues('val=axbyczzd', secrets.values()), 'val=axbyczzd')
  })

  it('longest-first — 짧은 secret이 긴 secret의 부분일 때 부분 마스킹 방지', () => {
    const secrets = new Map([['SHORT', 'abc'], ['LONG', 'abcdef']])
    // 'abcdef'를 먼저 치환해야 'abcXYZ'식 잔재가 남지 않음
    assert.equal(maskSecretValues('x=abcdef', secrets.values()), 'x=***')
  })

  it('빈 값은 무시 (전체 치환으로 출력 훼손 방지)', () => {
    const secrets = new Map([['EMPTY', '']])
    assert.equal(maskSecretValues('unchanged text', secrets.values()), 'unchanged text')
  })

  it('secret 없으면 원문 그대로', () => {
    assert.equal(maskSecretValues('plain output', new Map().values()), 'plain output')
  })

  it('non-string 입력도 안전', () => {
    assert.equal(maskSecretValues(undefined, new Map().values()), '')
  })
})

describe('isMcpToolName', () => {
  it('mcp__server__tool은 true', () => {
    assert.equal(isMcpToolName('mcp__wiki__wiki_read'), true)
    assert.equal(isMcpToolName('mcp__a__b'), true)
  })
  it('prefix 누락 또는 server 분리자 없으면 false', () => {
    assert.equal(isMcpToolName('Read'), false)
    assert.equal(isMcpToolName('mcp__only_one_segment'), false)
    assert.equal(isMcpToolName('mcp__'), false)
    assert.equal(isMcpToolName(''), false)
  })
})

// ── normalizeMcpToolResult ────────────────────────────────────────────

describe('normalizeMcpToolResult', () => {
  it('단일 text 블록 → string 평탄화', () => {
    const r = normalizeMcpToolResult({ content: [{ type: 'text', text: 'hello' }] })
    assert.deepEqual(r, { content: 'hello' })
  })

  it('text 블록 2개+ → array 유지', () => {
    const r = normalizeMcpToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })
    assert.deepEqual(r.content, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  })

  it('isError → is_error', () => {
    const r = normalizeMcpToolResult({ content: [{ type: 'text', text: 'oops' }], isError: true })
    assert.equal(r.is_error, true)
    assert.equal(r.content, 'oops')
  })

  it('image 블록 → placeholder text', () => {
    const r = normalizeMcpToolResult({
      content: [{ type: 'image', mimeType: 'image/png', data: '...' }],
    })
    assert.equal(r.content, '[image: image/png, omitted]')
  })

  it('빈 content → (no output)', () => {
    const r = normalizeMcpToolResult({ content: [] })
    assert.equal(r.content, '(no output)')
  })

  it('null/falsy → (no output)', () => {
    assert.equal(normalizeMcpToolResult(null).content, '(no output)')
    assert.equal(normalizeMcpToolResult(undefined).content, '(no output)')
  })

  it('type 누락 + text 있음 → fallback', () => {
    const r = normalizeMcpToolResult({ content: [{ text: 'plain' }] })
    assert.equal(r.content, 'plain')
  })
})

// ── createMcpHttpClient ───────────────────────────────────────────────

describe('createMcpHttpClient — 기본', () => {
  it('listTools → initialize 자동 호출 + tools 정규화', async () => {
    const { fetchFn, calls } = mockMcpServer({
      routes: {
        initialize: () => ({ protocolVersion: '2025-06-18', capabilities: {} }),
        'tools/list': () => ({
          tools: [
            { name: 'wiki_read', description: 'read', inputSchema: { type: 'object' } },
            { name: 'wiki_list', description: 'list' },
          ],
        }),
      },
    })
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    const tools = await c.listTools()
    assert.equal(tools.length, 2)
    assert.equal(tools[0].name, 'wiki_read')
    assert.equal(tools[0].description, 'read')
    assert.equal(tools[1].inputSchema?.type, 'object')
    // 호출 시퀀스 확인: initialize → (notifications/initialized) → tools/list
    const methods = calls.map((c) => c.body?.method).filter(Boolean)
    assert.deepEqual(methods.slice(0, 1), ['initialize'])
    assert.ok(methods.includes('tools/list'))
  })

  it('callTool → result 정규화', async () => {
    const { fetchFn } = mockMcpServer({
      routes: {
        initialize: () => ({}),
        'tools/call': ({ name, arguments: args }) => {
          assert.equal(name, 'wiki_read')
          assert.deepEqual(args, { path: 'a.md' })
          return { content: [{ type: 'text', text: 'contents' }] }
        },
      },
    })
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    const result = await c.callTool('wiki_read', { path: 'a.md' })
    assert.equal(result.content, 'contents')
  })

  it('JSON-RPC error → throw with code', async () => {
    const { fetchFn } = mockMcpServer({
      routes: {
        initialize: () => ({}),
        'tools/call': () => ({ error: { code: -32602, message: 'invalid params' } }),
      },
    })
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    await assert.rejects(c.callTool('wiki_read', {}), /JSON-RPC error -32602/)
  })

  it('HTTP error → throw with status', async () => {
    const fetchFn = async () => new Response('rate limited', { status: 429 })
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    await assert.rejects(c.listTools(), /HTTP 429/)
  })

  it('인증 헤더가 outbound에 포함됨', async () => {
    const { fetchFn, calls } = mockMcpServer({
      routes: { initialize: () => ({}), 'tools/list': () => ({ tools: [] }) },
    })
    const c = createMcpHttpClient(
      { name: 'wiki', url: 'http://mock', headers: { Authorization: 'Bearer sk-test-secret' } },
      { fetchFn },
    )
    await c.listTools()
    const initCall = calls.find((c) => c.body?.method === 'initialize')
    assert.equal(initCall.headers.Authorization, 'Bearer sk-test-secret')
  })

  it('에러 메시지에서 인증 토큰 마스킹', async () => {
    const { fetchFn } = mockMcpServer({
      routes: {
        initialize: () => ({}),
        'tools/call': () => ({ error: { code: -32603, message: 'failed for Bearer sk-test-secret' } }),
      },
    })
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    try {
      await c.callTool('x', {})
      assert.fail('should have thrown')
    } catch (err) {
      assert.ok(!err.message.includes('sk-test-secret'), `token leaked: ${err.message}`)
      assert.ok(err.message.includes('***'), `expected mask, got: ${err.message}`)
    }
  })

  it('SSE(text/event-stream) 응답을 파싱해 JSON-RPC result 반환', async () => {
    const sse = (id, result) => new Response(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
    const fetchFn = async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.method?.startsWith('notifications/')) return new Response('', { status: 200 })
      if (body.method === 'initialize') return sse(body.id, { protocolVersion: '2025-06-18', capabilities: {} })
      if (body.method === 'tools/call') return sse(body.id, { content: [{ type: 'text', text: 'sse-ok' }] })
      return sse(body.id, {})
    }
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    const result = await c.callTool('wiki_read', {})
    assert.equal(result.content, 'sse-ok')
  })

  it('SSE 스트림에서 notification·다른 id는 건너뛰고 매칭 id만 추출', async () => {
    const fetchFn = async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.method?.startsWith('notifications/')) return new Response('', { status: 200 })
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }),
          { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // 잡음(notification) + 다른 id + 매칭 id 순으로 흘려보냄
      const noise = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'progress', params: {} })}\n\n`
      const wrong = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: { content: [{ type: 'text', text: 'WRONG' }] } })}\n\n`
      const right = `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'RIGHT' }] } })}\n\n`
      return new Response(noise + wrong + right, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    const result = await c.callTool('x', {})
    assert.equal(result.content, 'RIGHT')
  })

  it('tools/list pagination — nextCursor로 여러 페이지 합치기', async () => {
    const { fetchFn } = mockMcpServer({
      routes: {
        initialize: () => ({}),
        'tools/list': (params) => {
          if (!params.cursor) return { tools: [{ name: 'a' }], nextCursor: 'c1' }
          if (params.cursor === 'c1') return { tools: [{ name: 'b' }], nextCursor: 'c2' }
          return { tools: [{ name: 'c' }] }
        },
      },
    })
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    const tools = await c.listTools()
    assert.deepEqual(tools.map((t) => t.name), ['a', 'b', 'c'])
  })

  it('initialize 응답 Mcp-Session-Id를 이후 요청 헤더에 동봉', async () => {
    const calls = []
    const fetchFn = async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ method: body.method, headers: init.headers })
      if (body.method?.startsWith('notifications/')) return new Response('', { status: 200 })
      const headers = { 'content-type': 'application/json' }
      if (body.method === 'initialize') headers['mcp-session-id'] = 'sess-xyz'
      const result = body.method === 'tools/list' ? { tools: [] } : {}
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers })
    }
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    await c.listTools()
    const initCall = calls.find((c) => c.method === 'initialize')
    const listCall = calls.find((c) => c.method === 'tools/list')
    assert.equal(initCall.headers['mcp-session-id'], undefined, 'initialize 자체엔 세션 id 없음')
    assert.equal(listCall.headers['mcp-session-id'], 'sess-xyz', '캡처한 세션 id가 이후 요청에 동봉')
  })

  it('spec 검증 — url/name 필수 + http transport 외 거부', () => {
    assert.throws(() => createMcpHttpClient({}, {}), /spec\.url/)
    assert.throws(() => createMcpHttpClient({ url: 'x' }, {}), /spec\.name/)
    assert.throws(
      () => createMcpHttpClient({ name: 'a', url: 'x', transport: 'stdio' }, {}),
      /only 'http' transport/,
    )
  })

  it('SSRF 가드 — 위험 스킴/메타데이터/loopback URL 거부', () => {
    const mk = (url) => () => createMcpHttpClient({ name: 'a', url }, {})
    assert.throws(mk('file:///etc/passwd'), /unsupported URL scheme/)
    assert.throws(mk('ftp://example.com'), /unsupported URL scheme/)
    assert.throws(mk('http://169.254.169.254/latest/meta-data/'), /blocked URL host/)
    assert.throws(mk('http://metadata.google.internal/'), /blocked URL host/)
    assert.throws(mk('http://127.0.0.1:8080/'), /blocked URL host/)
    assert.throws(mk('http://localhost/'), /blocked URL host/)
    assert.doesNotThrow(mk('https://mcp.example.com/rpc'))
  })

  it('close 후 호출은 closed 에러', async () => {
    const { fetchFn } = mockMcpServer({
      routes: { initialize: () => ({}), 'tools/list': () => ({ tools: [] }) },
    })
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    await c.close()
    await assert.rejects(c.listTools(), /closed/)
  })
})

// ── createMcpToolRegistry ─────────────────────────────────────────────

describe('createMcpToolRegistry — 멀티 서버 라우팅', () => {
  it('서버별 도구를 mcp__<server>__<tool>로 프리픽스', async () => {
    const { fetchFn: f1 } = mockMcpServer({
      url: 'http://wiki',
      routes: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'wiki_read' }, { name: 'wiki_list' }] }),
      },
    })
    const { fetchFn: f2 } = mockMcpServer({
      url: 'http://search',
      routes: { initialize: () => ({}), 'tools/list': () => ({ tools: [{ name: 'query' }] }) },
    })
    // 단일 fetchFn에 URL 라우팅
    const router = async (url, init) => {
      if (url === 'http://wiki') return f1(url, init)
      if (url === 'http://search') return f2(url, init)
      return new Response('not found', { status: 404 })
    }
    const reg = await createMcpToolRegistry(
      [
        { name: 'wiki', url: 'http://wiki' },
        { name: 'search', url: 'http://search' },
      ],
      { fetchFn: router },
    )
    try {
      assert.equal(reg.tools.length, 3)
      const names = reg.tools.map((t) => t.name).sort()
      assert.deepEqual(names, ['mcp__search__query', 'mcp__wiki__wiki_list', 'mcp__wiki__wiki_read'])
    } finally {
      await reg.close()
    }
  })

  it('runTool은 프리픽스 파싱해 적절한 서버로 라우팅', async () => {
    let calledOn = ''
    const { fetchFn: f1 } = mockMcpServer({
      url: 'http://wiki',
      routes: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'wiki_read' }] }),
        'tools/call': ({ name }) => { calledOn = `wiki:${name}`; return { content: [{ type: 'text', text: 'A' }] } },
      },
    })
    const { fetchFn: f2 } = mockMcpServer({
      url: 'http://search',
      routes: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'query' }] }),
        'tools/call': ({ name }) => { calledOn = `search:${name}`; return { content: [{ type: 'text', text: 'B' }] } },
      },
    })
    const router = async (url, init) => (url === 'http://wiki' ? f1(url, init) : f2(url, init))
    const reg = await createMcpToolRegistry(
      [
        { name: 'wiki', url: 'http://wiki' },
        { name: 'search', url: 'http://search' },
      ],
      { fetchFn: router },
    )
    try {
      const r1 = await reg.runTool('mcp__wiki__wiki_read', { path: 'x' })
      assert.equal(r1.content, 'A')
      assert.equal(calledOn, 'wiki:wiki_read')
      const r2 = await reg.runTool('mcp__search__query', {})
      assert.equal(r2.content, 'B')
      assert.equal(calledOn, 'search:query')
    } finally {
      await reg.close()
    }
  })

  it('등록되지 않은 프리픽스 → throw', async () => {
    const reg = await createMcpToolRegistry([], {})
    try {
      await assert.rejects(reg.runTool('mcp__unknown__foo', {}), /not found in registry/)
    } finally {
      await reg.close()
    }
  })

  it('중복 서버 이름 → throw', async () => {
    const { fetchFn } = mockMcpServer({ routes: { initialize: () => ({}), 'tools/list': () => ({ tools: [] }) } })
    await assert.rejects(
      createMcpToolRegistry(
        [{ name: 'wiki', url: 'http://a' }, { name: 'wiki', url: 'http://b' }],
        { fetchFn },
      ),
      /duplicate server name/,
    )
  })

  it('일부 서버 listTools 실패해도 다른 서버는 정상 동작', async () => {
    const { fetchFn: f1 } = mockMcpServer({
      url: 'http://good',
      routes: { initialize: () => ({}), 'tools/list': () => ({ tools: [{ name: 'foo' }] }) },
    })
    const f2 = async () => new Response('down', { status: 500 })
    const router = async (url, init) => (url === 'http://good' ? f1(url, init) : f2(url, init))
    const reg = await createMcpToolRegistry(
      [{ name: 'good', url: 'http://good' }, { name: 'bad', url: 'http://bad' }],
      { fetchFn: router },
    )
    try {
      assert.equal(reg.tools.length, 1)
      assert.equal(reg.tools[0].name, 'mcp__good__foo')
    } finally {
      await reg.close()
    }
  })

  it('getClient로 개별 client 접근', async () => {
    const { fetchFn } = mockMcpServer({
      routes: { initialize: () => ({}), 'tools/list': () => ({ tools: [] }) },
    })
    const reg = await createMcpToolRegistry([{ name: 'wiki', url: 'http://mock' }], { fetchFn })
    try {
      const client = reg.getClient('wiki')
      assert.ok(client)
      assert.equal(client.getServerName(), 'wiki')
      assert.equal(reg.getClient('absent'), undefined)
    } finally {
      await reg.close()
    }
  })
})

// ── turn-manager 통합 (mcpServers 자동 wiring) ────────────────────────

describe('turn-manager × mcp-client 통합', () => {
  it('options.mcpServers 전달 시 도구 자동 머지 + 라우팅', async () => {
    const { runAnthropicTurnManager } = await import('./turn-manager.js')

    // MCP 서버 mock
    const mcpFetch = mockMcpServer({
      url: 'http://wiki',
      routes: {
        initialize: () => ({}),
        'tools/list': () => ({
          tools: [{ name: 'wiki_read', description: 'read wiki', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
        }),
        'tools/call': ({ name, arguments: args }) => {
          assert.equal(name, 'wiki_read')
          assert.deepEqual(args, { path: 'a.md' })
          return { content: [{ type: 'text', text: 'wiki contents' }] }
        },
      },
    }).fetchFn

    // Anthropic Messages API mock — turn 1: mcp tool_use, turn 2: 종료
    let anthropicTurn = 0
    let anthropicBody = null
    const sse1 =
      `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'mcp__wiki__wiki_read', input: {} } })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.md"}' } })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } })}\n\n` +
      `event: message_stop\ndata: {}\n\n`
    const sse2 =
      `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 30, output_tokens: 0 } } })}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text: 'done' } })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n` +
      `event: message_stop\ndata: {}\n\n`

    const anthropicFetch = async (_url, init) => {
      anthropicTurn++
      anthropicBody = JSON.parse(init.body)
      const text = anthropicTurn === 1 ? sse1 : sse2
      return new Response(
        new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() } }),
        { status: 200 },
      )
    }

    const yielded = []
    for await (const m of runAnthropicTurnManager(
      {
        prompt: 'read a.md',
        options: {
          model: 'claude-sonnet-4-6',
          mcpServers: [{ name: 'wiki', url: 'http://wiki' }],
        },
      },
      { fetchFn: anthropicFetch, mcpFetchFn: mcpFetch, apiKey: 'sk-test' },
    )) {
      yielded.push(m)
    }

    // Anthropic 요청에 MCP 도구가 머지됨
    assert.ok(anthropicBody.tools)
    assert.equal(anthropicBody.tools[0].name, 'mcp__wiki__wiki_read')

    // 흐름: assistant(tool_use) → user(tool_result) → assistant(text) → result
    assert.equal(yielded.length, 4)
    assert.equal(yielded[1].type, 'user')
    assert.equal(yielded[1].message.content[0].content, 'wiki contents')
    assert.equal(yielded[3].subtype, 'success')
  })

  it('mcpServers + userTools 함께 사용', async () => {
    const { runAnthropicTurnManager } = await import('./turn-manager.js')
    const mcpFetch = mockMcpServer({
      url: 'http://wiki',
      routes: {
        initialize: () => ({}),
        'tools/list': () => ({ tools: [{ name: 'wiki_read' }] }),
      },
    }).fetchFn

    let observedTools = null
    const ssePayload =
      `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })}\n\n` +
      `event: message_stop\ndata: {}\n\n`
    const anthropicFetch = async (_url, init) => {
      observedTools = JSON.parse(init.body).tools
      return new Response(
        new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ssePayload)); c.close() } }),
        { status: 200 },
      )
    }

    for await (const _ of runAnthropicTurnManager(
      {
        prompt: 'x',
        options: {
          model: 'claude-sonnet-4-6',
          tools: [{ name: 'Read', input_schema: { type: 'object' } }],
          mcpServers: [{ name: 'wiki', url: 'http://wiki' }],
        },
      },
      { fetchFn: anthropicFetch, mcpFetchFn: mcpFetch, apiKey: 'k' },
    )) { /* consume */ }

    const names = observedTools.map((t) => t.name).sort()
    assert.deepEqual(names, ['Read', 'mcp__wiki__wiki_read'])
  })
})
