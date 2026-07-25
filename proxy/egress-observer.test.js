import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EgressObserver, MAX_TRACKED_HOSTS, MAX_HOSTS_PER_REPORT } from './egress-observer.js'

/**
 * A-3 1단계 — egress 관측기. **차단하지 않고** 목적지 호스트만 집계해 cloud에 주기 보고한다.
 * 도메인 allowlist(2단계) 프리셋을 추측이 아니라 실측에서 도출하기 위한 수집 단계.
 */

const silent = { info() {}, warn() {} }

/** fetch 목 — 호출 기록 + 응답 제어. */
function makeFetch(responses = [{ ok: true }]) {
  const calls = []
  let i = 0
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null })
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    if (r instanceof Error) throw r
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500) }
  }
  return { fn, calls }
}

function makeObserver(fetchImpl, extra = {}) {
  return new EgressObserver({
    proxyOrigin: 'https://cloud.example.com',
    workspaceId: 'ws-1',
    token: 'tok',
    fetchFn: fetchImpl,
    logger: silent,
    ...extra,
  })
}

describe('EgressObserver.record — 집계', () => {
  it('같은 호스트를 누적하고 소문자로 정규화한다', () => {
    const o = makeObserver(makeFetch().fn)
    o.record('registry.npmjs.org')
    o.record('REGISTRY.npmjs.ORG')
    const payload = o.buildPayload()
    assert.equal(payload.length, 1)
    assert.equal(payload[0].host, 'registry.npmjs.org')
    assert.equal(payload[0].requests, 2)
  })

  it('blocked 요청을 별도로 센다(기존 시크릿 방어가 실제로 발동한 지표)', () => {
    const o = makeObserver(makeFetch().fn)
    o.record('evil.example.com', { blocked: true })
    o.record('evil.example.com')
    const [row] = o.buildPayload()
    assert.equal(row.requests, 2)
    assert.equal(row.blocked, 1)
  })

  it('빈 호스트는 무시한다', () => {
    const o = makeObserver(makeFetch().fn)
    o.record('')
    o.record(undefined)
    assert.equal(o.buildPayload().length, 0)
  })

  it('호스트 종류 상한을 넘으면 새 호스트를 버린다(메모리 무한 증가 방지)', () => {
    const o = makeObserver(makeFetch().fn)
    for (let i = 0; i < MAX_TRACKED_HOSTS + 5; i++) o.record(`h${i}.example.com`)
    assert.equal(o.stats.size, MAX_TRACKED_HOSTS)
    assert.equal(o.droppedHosts, 5)
  })

  it('보고 payload는 요청 수 많은 순으로 상한까지만 담는다', () => {
    const o = makeObserver(makeFetch().fn)
    for (let i = 0; i < MAX_HOSTS_PER_REPORT + 10; i++) {
      // 상한 밖(뒤쪽)에 있지만 요청이 압도적으로 많은 호스트 — 잘림보다 빈도가 우선인지 확인
      const times = i === MAX_HOSTS_PER_REPORT + 5 ? 99 : 1
      for (let t = 0; t < times; t++) o.record(`h${i}.example.com`)
    }
    const payload = o.buildPayload()
    assert.equal(payload.length, MAX_HOSTS_PER_REPORT)
    assert.equal(payload[0].host, `h${MAX_HOSTS_PER_REPORT + 5}.example.com`)
  })

  it('경로·쿼리는 애초에 받지 않는다 — payload 필드는 host/건수/시각만', () => {
    const o = makeObserver(makeFetch().fn)
    o.record('api.notion.com')
    assert.deepEqual(Object.keys(o.buildPayload()[0]).sort(), [
      'blocked', 'first_seen', 'host', 'last_seen', 'requests',
    ])
  })
})

describe('EgressObserver.flush — 보고', () => {
  it('인증 헤더와 함께 POST하고 집계를 비운다', async () => {
    const { fn, calls } = makeFetch()
    const o = makeObserver(fn)
    o.record('github.com')
    const r = await o.flush()

    assert.equal(r.ok, true)
    assert.equal(r.reported, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://cloud.example.com/api/internal/egress-observations')
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok')
    assert.equal(calls[0].init.headers['x-workspace-id'], 'ws-1')
    assert.equal(calls[0].body.observations[0].host, 'github.com')
    assert.equal(o.stats.size, 0)
  })

  it('집계가 없으면 아무것도 보내지 않는다', async () => {
    const { fn, calls } = makeFetch()
    const o = makeObserver(fn)
    await o.flush()
    assert.equal(calls.length, 0)
  })

  it('보고 실패 시 카운트를 되돌려 다음 주기에 합쳐 재시도한다', async () => {
    const { fn, calls } = makeFetch([{ ok: false, status: 500 }, { ok: true }])
    const o = makeObserver(fn)
    o.record('pypi.org')
    const first = await o.flush()
    assert.equal(first.ok, false)

    // 되돌려졌으므로 다음 요청과 합쳐진다
    o.record('pypi.org')
    const second = await o.flush()
    assert.equal(second.ok, true)
    assert.equal(calls[1].body.observations[0].requests, 2)
    assert.equal(o.stats.size, 0)
  })

  it('네트워크 예외도 되돌린다', async () => {
    const { fn } = makeFetch([new Error('ECONNREFUSED')])
    const o = makeObserver(fn)
    o.record('files.pythonhosted.org')
    const r = await o.flush()
    assert.equal(r.ok, false)
    assert.equal(o.stats.get('files.pythonhosted.org').requests, 1)
  })

  it('보고 설정이 없으면(로컬 dev) 집계만 하고 폐기 — 무한 증가 방지', async () => {
    const o = new EgressObserver({ logger: silent })
    o.record('example.com')
    assert.equal(o.canReport, false)
    const r = await o.flush()
    assert.equal(r.ok, true)
    assert.equal(o.stats.size, 0)
  })
})

describe('EgressObserver — 관측은 프록시를 막지 않는다', () => {
  let recorded
  beforeEach(() => {
    recorded = []
  })

  it('record는 동기·반환값 없음 — hot path에서 await하지 않는다', () => {
    const o = makeObserver(makeFetch().fn)
    const ret = o.record('cdn.example.com')
    assert.equal(ret, undefined)
    recorded.push(ret)
  })

  it('start는 중복 호출해도 타이머를 하나만 만든다', () => {
    const o = makeObserver(makeFetch().fn)
    o.start(60_000)
    const first = o.timer
    o.start(60_000)
    assert.equal(o.timer, first)
    clearInterval(o.timer)
  })
})
