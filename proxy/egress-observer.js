/**
 * egress 관측기 — 샌드박스가 실제로 접속한 호스트를 집계해 cloud에 주기 보고한다 (A-3 1단계).
 *
 * ## 왜
 *
 * 공급망·네트워크 게이트가 지금은 **명령어 정규식 deny-list**다(`policy-sandbox-gate.json`).
 * 목록에 없는 도구(`gh`·`svn`·`composer`·`deno` 등)는 그대로 통과하고, 규칙 하나를 바꾸려면
 * 5곳을 동시에 갱신하고 러너를 릴리스해야 한다. 레퍼런스(Claude Code `allowedDomains` + 프록시
 * 403 · vellum CES egress mode)는 전부 **목적지(도메인) allowlist**로 수렴한다.
 *
 * 전환하려면 "무엇을 허용할지"를 알아야 하는데, 추측으로 목록을 만들면 정상 작업이 반드시 막힌다
 * (npm이 registry 외 CDN을 치는 등). 그래서 차단 전에 관측만 한다. 이 모듈은 **아무것도 막지 않는다.**
 *
 * ## 무엇을 기록하는가
 *
 * **호스트와 건수만.** 경로·쿼리·헤더·바디는 만지지 않는다 — 토큰·PII가 섞일 수 있고 allowlist
 * 판단에는 호스트만 필요하다. 이 원칙은 cloud 라우트의 Zod 스키마(호스트 정규식)로도 이중 강제된다.
 *
 * ## 동작
 *
 * 메모리 Map에 누적하고 `FLUSH_INTERVAL_MS`마다 변경분만 POST한다. 요청마다 보내지 않는 이유 —
 * `npm install` 한 번이 수백 요청이라 보고가 관측 대상보다 시끄러워진다.
 * 보고 실패는 무시하고 카운트를 되돌린다(다음 주기에 합쳐 재시도) — 관측이 직원 동작을 막아선 안 된다.
 */

/** 보고 주기(ms). 짧으면 요청 수만큼 시끄럽고, 길면 샌드박스가 죽을 때 유실이 커진다. */
export const FLUSH_INTERVAL_MS = 60_000

/** 한 번의 보고에 담는 최대 호스트 수 — cloud MAX_HOSTS_PER_REPORT와 같은 값. */
export const MAX_HOSTS_PER_REPORT = 200

/** 메모리 상한 — 서로 다른 호스트가 이보다 많아지면 새 호스트는 버린다(무한 증가 방지). */
export const MAX_TRACKED_HOSTS = 2_000

const OBSERVATIONS_PATH = '/api/internal/egress-observations'

/**
 * @typedef {object} HostStat
 * @property {number} requests
 * @property {number} blocked
 * @property {number} firstAtMs
 * @property {number} lastAtMs
 */

export class EgressObserver {
  /**
   * @param {{
   *   proxyOrigin?: string, workspaceId?: string, token?: string,
   *   fetchFn?: typeof fetch, logger?: { info: Function, warn: Function },
   *   nowFn?: () => number,
   * }} opts
   */
  constructor({ proxyOrigin, workspaceId, token, fetchFn, logger, nowFn } = {}) {
    this.proxyOrigin = proxyOrigin
    this.workspaceId = workspaceId
    this.token = token
    this.fetchFn = fetchFn ?? globalThis.fetch
    this.log = logger ?? { info() {}, warn() {} }
    this.now = nowFn ?? (() => Date.now())
    /** @type {Map<string, HostStat>} */
    this.stats = new Map()
    this.timer = null
    this.droppedHosts = 0
  }

  /** 보고에 필요한 설정이 모두 있는지(로컬 dev는 없을 수 있다 — 그때는 집계만 하고 보고 안 함). */
  get canReport() {
    return Boolean(this.proxyOrigin && this.workspaceId && this.token && this.fetchFn)
  }

  /**
   * 요청 1건 기록. 프록시 hot path에서 호출되므로 동기·O(1)만 한다.
   * @param {string} host 목적지 호스트(소문자 기대)
   * @param {{ blocked?: boolean }} [opts] blocked=true면 프록시가 403으로 막은 요청
   */
  record(host, opts = {}) {
    if (!host) return
    const key = String(host).toLowerCase()
    const at = this.now()
    const cur = this.stats.get(key)
    if (cur) {
      cur.requests += 1
      if (opts.blocked) cur.blocked += 1
      cur.lastAtMs = at
      return
    }
    if (this.stats.size >= MAX_TRACKED_HOSTS) {
      this.droppedHosts += 1
      return
    }
    this.stats.set(key, { requests: 1, blocked: opts.blocked ? 1 : 0, firstAtMs: at, lastAtMs: at })
  }

  /** 현재 집계를 cloud 보고 payload로 변환(요청 수 많은 순으로 상한까지). */
  buildPayload() {
    const entries = [...this.stats.entries()]
      .sort((a, b) => b[1].requests - a[1].requests)
      .slice(0, MAX_HOSTS_PER_REPORT)
    return entries.map(([host, s]) => ({
      host,
      requests: s.requests,
      blocked: s.blocked,
      first_seen: new Date(s.firstAtMs).toISOString(),
      last_seen: new Date(s.lastAtMs).toISOString(),
    }))
  }

  /**
   * 집계를 비우고 보고한다. 실패하면 비운 분을 **되돌려** 다음 주기에 합쳐 재시도한다.
   * @returns {Promise<{ reported: number, ok: boolean }>}
   */
  async flush() {
    if (this.stats.size === 0) return { reported: 0, ok: true }
    if (!this.canReport) {
      // 로컬 dev 등 — 집계가 무한히 쌓이지 않도록 비우고 로그만 남긴다.
      const hosts = this.stats.size
      this.stats.clear()
      this.log.info('[egress-observer] 보고 설정 없음 — 집계 폐기', { hosts })
      return { reported: 0, ok: true }
    }

    const observations = this.buildPayload()
    const taken = new Map(this.stats)
    this.stats.clear()

    try {
      const url = this.proxyOrigin.replace(/\/+$/, '') + OBSERVATIONS_PATH
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
          'x-workspace-id': this.workspaceId,
        },
        body: JSON.stringify({ observations }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (this.droppedHosts > 0) {
        this.log.warn('[egress-observer] 호스트 상한 초과로 일부 미집계', { dropped: this.droppedHosts })
        this.droppedHosts = 0
      }
      return { reported: observations.length, ok: true }
    } catch (err) {
      // 되돌리기 — 그 사이 새로 들어온 카운트와 합친다(유실보다 중복 없는 누적이 중요).
      for (const [host, s] of taken) {
        const cur = this.stats.get(host)
        if (!cur) {
          this.stats.set(host, s)
          continue
        }
        cur.requests += s.requests
        cur.blocked += s.blocked
        cur.firstAtMs = Math.min(cur.firstAtMs, s.firstAtMs)
        cur.lastAtMs = Math.max(cur.lastAtMs, s.lastAtMs)
      }
      this.log.warn('[egress-observer] 보고 실패 — 다음 주기에 재시도', {
        error: err instanceof Error ? err.message : String(err),
        hosts: taken.size,
      })
      return { reported: 0, ok: false }
    }
  }

  /** 주기 보고 시작(중복 호출 안전). unref로 프로세스 종료를 막지 않는다. */
  start(intervalMs = FLUSH_INTERVAL_MS) {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flush()
    }, intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 주기 보고 중단 + 마지막 집계 보고(graceful shutdown에서 호출). */
  async stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.flush()
  }
}
