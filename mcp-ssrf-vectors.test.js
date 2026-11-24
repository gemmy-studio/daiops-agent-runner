/**
 * MCP 서버 주소 SSRF 가드: 외부에서 쓰는 우회 표기 모음으로 굳힌다(트랙 G5, 2026-11-25).
 *
 * 출처(원문 확인):
 *  - OWASP SSRF Prevention Cheat Sheet: 16진, 8진, Dword 표기, IPv4-mapped `::ffff:169.254.169.254`, NAT64
 *  - ssrf-req-filter test/fixtures/blockedUrls.js: 루프백, 메타데이터 우회 표기
 *  - request-filtering-agent: 가짜 DNS 로 해소 결과를 주입해 해소 뒤 판정을 본다
 *
 * 기본 대역(10/8 등)과 loopback opt-in 은 mcp-client.test.js, mcp-hardening.test.js 가 본다. 여기는 표기 우회만.
 * `todo` 로 둔 것은 지금 가드를 통과하는 표기다. 고칠지와 고치는 법은 보안 세션이 정한다(G 는 시험만, 고치지 않음).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createMcpHttpClient, _resetDnsGuardCache } from './mcp-client.js'

const neverFetch = async () => {
  throw new Error('fetch 가 불리면 안 된다(가드가 먼저 막아야 함)')
}
const make = (url, opts = {}) => () => createMcpHttpClient({ name: 'x', url, ...opts })

describe('SSRF 가드: 주소 글자 단계에서 막는 표기', () => {
  // URL 파서가 먼저 표준형으로 바꾸므로 여기 표기는 모두 127.0.0.1, 169.254.169.254, 0.0.0.0 으로 판정된다
  const blocked = [
    ['8진 루프백', 'http://0177.0.0.1/'],
    ['10진 정수 루프백', 'http://2130706433/'],
    ['16진 정수 루프백', 'http://0x7f000001/'],
    ['줄인 루프백', 'http://127.1/'],
    ['userinfo 뒤 진짜 호스트', 'http://127.1.1.1:80@127.2.2.2:80/'],
    ['0 하나', 'http://0/'],
    ['IPv6 미지정', 'http://[::]/'],
    ['IPv6 루프백', 'http://[::1]/'],
    ['대문자 localhost', 'http://LOCALHOST/'],
    ['16진 메타데이터', 'http://0xA9FEA9FE/'],
    ['10진 정수 메타데이터', 'http://2852039166/'],
    ['8진 메타데이터', 'http://0251.0376.0251.0376/'],
    ['ECS 자격 증명 주소', 'http://169.254.170.2/'],
    ['AWS IPv6 메타데이터(ULA)', 'http://[fd00:ec2::254]/'],
    ['IPv4-mapped 사설', 'http://[::ffff:10.0.0.1]/'],
    ['.internal 이름', 'http://metadata.google.internal/'],
  ]
  for (const [label, url] of blocked) {
    it(`${label}: ${url}`, () => {
      assert.throws(make(url), /blocked URL host/)
    })
  }

  it('사무실판 중계(127.0.0.1:8792)는 allowLoopback 일 때 통과한다(ADR 33)', () => {
    assert.doesNotThrow(make('http://127.0.0.1:8792/mcp', { allowLoopback: true }))
  })

  it('allowLoopback 이어도 메타데이터 우회 표기는 막는다', () => {
    assert.throws(make('http://0xA9FEA9FE/', { allowLoopback: true }), /metadata/)
  })

  it('보통 도메인은 통과한다', () => {
    assert.doesNotThrow(make('https://mcp.example.com/mcp'))
  })
})

describe('SSRF 가드: 지금 통과하는 표기(보안 세션 넘김)', () => {
  const holes = [
    ['IPv4-mapped 루프백', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped 루프백(풀어 쓴 꼴)', 'http://[0:0:0:0:0:ffff:127.0.0.1]/'],
    ['IPv4-mapped 메타데이터', 'http://[::ffff:169.254.169.254]/'],
    ['IPv4-mapped 0.0.0.0', 'http://[::ffff:0.0.0.0]/'],
    ['IPv4-compatible 루프백', 'http://[::127.0.0.1]/'],
    ['NAT64 메타데이터', 'http://[64:ff9b::a9fe:a9fe]/'],
    ['IPv6 site-local(폐기 대역)', 'http://[fec0::1]/'],
  ]
  for (const [label, url] of holes) {
    it(`${label}: ${url}`, { todo: '지금 통과함. 보안 세션 9b9bf57e 에 넘김(11/25)' }, () => {
      assert.throws(make(url), /blocked URL host/)
    })
  }
})

describe('SSRF 가드: DNS 해소 뒤 판정', () => {
  const viaDns = async (addresses, opts = {}) => {
    _resetDnsGuardCache()
    const c = createMcpHttpClient(
      { name: 'x', url: 'https://evil.example.com/mcp', ...opts },
      { fetchFn: neverFetch, lookupFn: async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) },
    )
    return c.listTools()
  }

  it('해소 결과가 0.0.0.0 이면 막는다', async () => {
    await assert.rejects(() => viaDns(['0.0.0.0']), /resolves to wildcard/)
  })

  it('해소 결과가 IPv6 루프백이면 막는다', async () => {
    await assert.rejects(() => viaDns(['::1']), /resolves to loopback/)
  })

  it('IPv4-mapped 사설로 해소되면 막는다', async () => {
    await assert.rejects(() => viaDns(['::ffff:10.0.0.1']), /resolves to private network/)
  })

  it('공인 주소 뒤에 루프백을 섞어도 막는다', async () => {
    await assert.rejects(() => viaDns(['93.184.216.34', '127.0.0.1']), /resolves to loopback/)
  })

  it('allowLoopback 이어도 메타데이터로 해소되면 막는다', async () => {
    await assert.rejects(() => viaDns(['169.254.169.254'], { allowLoopback: true }), /resolves to metadata/)
  })

  const dnsHoles = [
    ['IPv4-mapped 루프백', '::ffff:127.0.0.1'],
    ['IPv4-mapped 메타데이터', '::ffff:169.254.169.254'],
    ['IPv4-compatible 루프백', '::7f00:1'],
  ]
  for (const [label, address] of dnsHoles) {
    it(`${label}(${address})로 해소되면 막는다`, { todo: '지금 통과함. 보안 세션 9b9bf57e 에 넘김(11/25)' }, async () => {
      await assert.rejects(() => viaDns([address]), /resolves to/)
    })
  }
})
