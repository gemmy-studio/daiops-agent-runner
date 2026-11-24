/**
 * MCP 서버 주소 SSRF 가드: 외부에서 쓰는 우회 표기 모음으로 굳힌다(트랙 G5, 2026-11-25).
 *
 * 출처(원문 확인):
 *  - OWASP SSRF Prevention Cheat Sheet: 16진, 8진, Dword 표기, IPv4-mapped `::ffff:169.254.169.254`, NAT64
 *  - ssrf-req-filter test/fixtures/blockedUrls.js: 루프백, 메타데이터 우회 표기
 *  - request-filtering-agent: 가짜 DNS 로 해소 결과를 주입해 해소 뒤 판정을 본다
 *
 * 기본 대역(10/8 등)과 loopback opt-in 은 mcp-client.test.js, mcp-hardening.test.js 가 본다. 여기는 표기 우회만.
 * IPv4 를 품은 IPv6 표기 10건은 처음 쓸 때 가드를 통과했다(todo). 대표 결정(보안 카드 9b9bf57e-2611250830 「지금 바로 고치기」)으로
 * 같은 가지에서 고쳤고 지금은 막는 시험이다.
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

  it('공인 IPv6 와 공인 IPv4 를 품은 사상 표기는 통과한다(풀어서 판정해도 막지 않음)', () => {
    assert.doesNotThrow(make('https://[2606:4700:4700::1111]/mcp'))
    assert.doesNotThrow(make('https://[::ffff:93.184.216.34]/mcp'))
  })

  it('allowLoopback 이어도 IPv6 에 실린 메타데이터는 막는다', () => {
    assert.throws(make('http://[::ffff:169.254.169.254]/', { allowLoopback: true }), /metadata/)
  })

  it('공인 IPv4 를 실은 6to4 와 경계 밖 공인 주소는 통과한다', () => {
    assert.doesNotThrow(make('http://[2002:5db8:d822::1]/'))
    assert.doesNotThrow(make('http://198.20.0.1/'))
    assert.doesNotThrow(make('http://192.0.1.1/'))
    assert.doesNotThrow(make('http://239.255.255.250/'))
  })

  it('allowLoopback 이면 사상 표기 루프백도 일반 루프백과 똑같이 통과한다', () => {
    assert.doesNotThrow(make('http://[::ffff:127.0.0.1]:8792/mcp', { allowLoopback: true }))
  })
})

describe('SSRF 가드: IPv6 에 실린 IPv4, 끝 점 이름, 특수 대역(11/25 고침 전 통과하던 것)', () => {
  const holes = [
    ['IPv4-mapped 루프백', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped 루프백(풀어 쓴 꼴)', 'http://[0:0:0:0:0:ffff:127.0.0.1]/'],
    ['IPv4-mapped 메타데이터', 'http://[::ffff:169.254.169.254]/'],
    ['IPv4-mapped 0.0.0.0', 'http://[::ffff:0.0.0.0]/'],
    ['IPv4-compatible 루프백', 'http://[::127.0.0.1]/'],
    ['NAT64 메타데이터', 'http://[64:ff9b::a9fe:a9fe]/'],
    ['IPv6 site-local(폐기 대역)', 'http://[fec0::1]/'],
    ['SIIT 메타데이터', 'http://[::ffff:0:a9fe:a9fe]/'],
    ['6to4 메타데이터', 'http://[2002:a9fe:a9fe::1]/'],
    ['6to4 사설', 'http://[2002:a00:1::1]/'],
    ['NAT64 지역용 대역', 'http://[64:ff9b:1::1]/'],
    ['풀어 쓴 IPv6 루프백', 'http://[0:0:0:0:0:0:0:1]/'],
    ['끝 점 붙인 localhost', 'http://localhost./'],
    ['끝 점 붙인 메타데이터 이름', 'http://metadata.google.internal./'],
    ['0.0.0.0/8', 'http://0.1.2.3/'],
    ['192.0.0.0/24', 'http://192.0.0.8/'],
    ['198.18.0.0/15 벤치마크', 'http://198.18.0.1/'],
    ['240.0.0.0/4 예약', 'http://240.0.0.1/'],
    ['방송 주소', 'http://255.255.255.255/'],
  ]
  for (const [label, url] of holes) {
    it(`${label}: ${url}`, () => {
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
    ['NAT64 메타데이터', '64:ff9b::a9fe:a9fe'],
    ['풀어 쓴 IPv6 루프백', '0:0:0:0:0:0:0:1'],
  ]
  it('공인 IPv4 를 실은 mapped 주소로 해소되면 통과한다', async () => {
    _resetDnsGuardCache()
    const c = createMcpHttpClient(
      { name: 'x', url: 'https://ok.example.com/mcp' },
      { fetchFn: async () => { throw new Error('fetched') }, lookupFn: async () => [{ address: '::ffff:93.184.216.34', family: 6 }] },
    )
    await assert.rejects(() => c.listTools(), /fetched/)
  })

  for (const [label, address] of dnsHoles) {
    it(`${label}(${address})로 해소되면 막는다`, async () => {
      await assert.rejects(() => viaDns([address]), /resolves to/)
    })
  }
})

describe('SSRF 가드: 대역 경계(돌연변이로 고름)', () => {
  const blocked = ['http://10.255.255.255/', 'http://172.31.255.255/', 'http://100.64.0.0/', 'http://100.127.255.255/',
    'http://192.168.255.255/', 'http://198.19.255.255/', 'http://[fdff::1]/', 'http://[febf::1]/', 'http://[feff::1]/']
  for (const url of blocked) it(`막는다: ${url}`, () => assert.throws(make(url), /blocked URL host/))

  const allowed = ['http://11.0.0.1/', 'http://172.15.255.255/', 'http://172.32.0.0/', 'http://100.63.255.255/',
    'http://100.128.0.0/', 'http://192.167.255.255/', 'http://192.169.0.0/', 'http://198.17.255.255/',
    'http://[fbff::1]/', 'http://[fe7f::1]/', 'http://[2001:db8::fc00:1]/', 'http://[2001:db8::fe80:1]/',
    'http://[64:ff9b:2::1]/', 'http://[64:ff9a:1::1]/', 'http://[65:ff9b:1::1]/']
  for (const url of allowed) it(`통과: ${url}`, () => assert.doesNotThrow(make(url)))
})

describe('SSRF 가드: DNS 판정 캐시와 시간 상한', () => {
  const passed = /fetched/
  const fetchMarks = async () => { throw new Error('fetched') }
  const client = (host, lookupFn) =>
    createMcpHttpClient({ name: 'x', url: `https://${host}/mcp` }, { fetchFn: fetchMarks, lookupFn })

  it('60초 안에 같은 이름은 다시 묻지 않는다(막힘도 통과도)', async () => {
    _resetDnsGuardCache()
    let asked = 0
    const bad = async () => { asked++; return [{ address: '10.0.0.1', family: 4 }] }
    await assert.rejects(() => client('cache-bad.example.com', bad).listTools(), /resolves to private/)
    await assert.rejects(() => client('cache-bad.example.com', bad).listTools(), /resolves to private/)
    assert.equal(asked, 1)
    let okAsked = 0
    const good = async () => { okAsked++; return [{ address: '93.184.216.34', family: 4 }] }
    await assert.rejects(() => client('cache-ok.example.com', good).listTools(), passed)
    await assert.rejects(() => client('cache-ok.example.com', good).listTools(), passed)
    assert.equal(okAsked, 1)
  })

  it('60초가 지나면 다시 묻는다(그사이 레코드가 바뀌면 새 판정)', async () => {
    _resetDnsGuardCache()
    const realNow = Date.now
    let addr = '93.184.216.34'
    let asked = 0
    const lookup = async () => { asked++; return [{ address: addr, family: 4 }] }
    try {
      const t0 = realNow()
      Date.now = () => t0
      await assert.rejects(() => client('rebind.example.com', lookup).listTools(), passed)
      addr = '127.0.0.1'
      Date.now = () => t0 + 59_000
      await assert.rejects(() => client('rebind.example.com', lookup).listTools(), passed)
      Date.now = () => t0 + 61_000
      await assert.rejects(() => client('rebind.example.com', lookup).listTools(), /resolves to loopback/)
      assert.equal(asked, 2)
    } finally {
      Date.now = realNow
    }
  })

  it('리졸버가 답하지 않으면 2초 뒤 판정을 포기하고 보낸다(fail-open)', async () => {
    _resetDnsGuardCache()
    const t0 = Date.now()
    await assert.rejects(() => client('hang.example.com', () => new Promise(() => {})).listTools(), passed)
    const waited = Date.now() - t0
    assert.ok(waited >= 1_900 && waited < 5_000, `waited ${waited}ms`)
  })

  it('리졸버가 배열이 아닌 값을 주면 보낸다', async () => {
    _resetDnsGuardCache()
    await assert.rejects(() => client('weird.example.com', async () => null).listTools(), passed)
  })

  it('주소 칸이 빈 항목은 건너뛰고 나머지로 판정한다', async () => {
    _resetDnsGuardCache()
    await assert.rejects(() => client('holes.example.com', async () => [{}, { address: '10.0.0.9', family: 4 }]).listTools(), /resolves to private/)
  })

  it('IP 글자 호스트는 DNS 에 묻지 않는다', async () => {
    _resetDnsGuardCache()
    let asked = 0
    const lookup = async () => { asked++; return [{ address: '10.0.0.1', family: 4 }] }
    await assert.rejects(() => client('93.184.216.34', lookup).listTools(), passed)
    await assert.rejects(() => client('[2606:4700:4700::1111]', lookup).listTools(), passed)
    assert.equal(asked, 0)
  })

  it('숫자와 점으로 시작하기만 하는 이름은 DNS 에 묻는다', async () => {
    _resetDnsGuardCache()
    let asked = 0
    const lookup = async () => { asked++; return [{ address: '10.0.0.1', family: 4 }] }
    await assert.rejects(() => client('1.2.3.4.nip.example.com', lookup).listTools(), /resolves to private/)
    // 끝 칸이 숫자인 이름(a1.2.3.4)은 URL 파서가 IPv4 로 읽으려다 거절하므로 여기까지 오지 않는다
    assert.equal(asked, 1)
  })

  it('캐시가 256개를 넘으면 비우고 다시 묻는다', async () => {
    _resetDnsGuardCache()
    let asked = 0
    const lookup = async () => { asked++; return [{ address: '93.184.216.34', family: 4 }] }
    for (let i = 0; i < 256; i++) await assert.rejects(() => client(`h${i}.example.com`, lookup).listTools(), passed)
    assert.equal(asked, 256)
    await assert.rejects(() => client('h0.example.com', lookup).listTools(), passed)
    assert.equal(asked, 256) // 아직 남아 있음
    await assert.rejects(() => client('h256.example.com', lookup).listTools(), passed) // 257번째: 비우고 저장
    await assert.rejects(() => client('h0.example.com', lookup).listTools(), passed)
    assert.equal(asked, 258)
  })
})
