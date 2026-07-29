/**
 * 도구 실행 자원 정형 — "정제-B"(박스 내부 자원 분리)의 **이름 없는** 구현.
 *
 * 무거운 로컬 도구(문서 파서 CLI·코드 실행·설치 등)가 단일 코어 샌드박스를 포화시켜, 같은 박스에서
 * 동시에 진행 중인 다른 세션 turn의 SSE 스트리밍·경량 도구를 스톨시키는 것을 막는다.
 * (concurrency-gate.ts가 관측·기록한 "1코어 CPU 100%·잦게 꺼졌다 켜졌다"의 도구 레벨 방어.)
 *
 * ## 정책 (Wave 2, 2026-07-29 — 명령 이름 판정 폐지)
 *
 *  - **우선순위**: Bash가 띄우는 *모든* 자식 프로세스를 `nice`로 감싼다. 러너 본체(nice 0)가 자식보다
 *    항상 우선한다는 불변식만 세운다. `nice`는 CPU가 남을 때 영향이 없으므로 경량 명령은 안 느려진다.
 *  - **개수**: 개수를 세지 않는다. 대신 spawn 직전 **실제 메모리 여유를 측정**해, 부족하면 상한 있는
 *    대기로 pacing한다(`admitTool`). 여유가 회복되지 않아도 결국 통과시킨다(fail-open) — 명령의
 *    실제 메모리 요구를 우리가 알 수 없으므로 거절은 또 다른 추측이기 때문. 정직한 개입은 pacing이다.
 *    **하드 상한은 커널에 맡긴다**(`tool-cgroup.js` — memory.high/memory.max).
 *  - **vCPU 파생**: `AGENT_RUNNER_VCPU`(cloud가 티어에서 배선) → cgroup `cpu.max` → `os.cpus()`.
 *    `os.cpus()`를 최후 폴백으로 강등한 이유: 컨테이너에서 cgroup CPU 한도를 보지 않고 호스트 코어
 *    수를 반환할 수 있어, 그 값으로 상한을 정하면 조용히 과대해진다.
 *
 * ## 왜 이름 목록을 버렸나 (Wave 2의 본질)
 *
 * 종전에는 `HEAVY_PATTERNS` 정규식 6개로 "무거운 명령"을 판정해 세마포어 슬롯을 잡게 했다.
 * 실측 결과 그 목록은 **양방향으로 틀렸다**:
 *  - 누락: `make`·`bash x.sh`·`./x.sh`·`tesseract`·`pandoc`·`pdftoppm`·`npm run build`·`uv run`·
 *    `tar/zip/7z`·`sqlite3`·`python3 -c '<루프>'` 등 10종 이상.
 *  - 오탐: `\bconvert\b`가 넓어 `git commit -m "convert to md"`가 heavy로 잡혔다. 레인 크기가 1인
 *    티어에서는 1초짜리 git 커밋이 유일한 슬롯을 점유한다 → "과분류는 안전"이 성립하지 않았다.
 *
 * 그리고 근본 원인은 개별 패턴의 품질이 아니라 **변경 주기의 불일치**다. 사용자가 만든 스킬은
 * `SKILL.md` 마크다운이라 그 자체가 분류 대상이 될 수 없고, 스킬이 *유도한* 명령만 목록에 걸리는데,
 * 스킬은 매주 생기고 목록은 릴리스로만 바뀐다. 따라잡을 수 없는 구조다.
 *
 * 같은 판단을 이 레포는 이미 한 번 내렸다 — `handler.js`의 도구 게이트가 러너 쪽 이름 목록 3종이
 * cloud 사본과 갈라져 사고를 두 번 낸 뒤, 목록을 고치는 대신 **삭제하고 "이름을 모르는 규칙"으로**
 * 바꿨다("드리프트할 데이터가 없으므로 재발 불가"). 여기도 같은 방향이다.
 *
 * 레퍼런스: 조사한 레퍼런스 4곳(openclaw·opencode·hermes·Claude Code) 중 **명령 이름으로 CPU 무게를
 *          분류하는 구현은 없었다.** openclaw는 컨테이너 자원 한도를 설정으로 노출(`cpus`·`memory`·
 *          `pidsLimit`·`ulimits`), opencode는 타임아웃만, hermes는 박스당 순차. 업계 표준은 cgroup v2
 *          `cpu.max`/`cpu.weight` — 즉 "이름을 몰라도 되는" 자원 계층에서 집행한다.
 *          별도 샌드박스 증설은 영속 정체성과 상충하여 미채택(ADR 45 §4).
 */

import os from 'node:os'
import { existsSync, readFileSync } from 'node:fs'

/** cgroup v2 인터페이스 파일 루트. runtime-probe.js와 동일 경로. */
const CGROUP_ROOT = '/sys/fs/cgroup'

/** 파일을 읽어 trim. 없거나 실패면 null. */
function readTrimmed(path) {
  try {
    return readFileSync(path, 'utf-8').trim()
  } catch {
    return null
  }
}

/**
 * 이 샌드박스에 실제로 할당된 vCPU 수.
 *
 * 우선순위: `AGENT_RUNNER_VCPU`(cloud 티어 배선, 가장 신뢰) → cgroup v2 `cpu.max`(커널 실측) →
 * `os.cpus()`(최후 폴백 — 컨테이너에서 호스트 코어를 반환할 수 있어 과대평가 위험).
 *
 * 부팅 1회 계산. 자원 배정은 샌드박스 수명 중 바뀌지 않는다(등급 변경은 재생성을 거친다).
 * @returns {number} 1 이상
 */
export const VCPU = (() => {
  const env = Number(process.env.AGENT_RUNNER_VCPU)
  if (Number.isFinite(env) && env >= 1) return Math.floor(env)

  const raw = readTrimmed(`${CGROUP_ROOT}/cpu.max`)
  if (raw) {
    const [quota, period] = raw.split(/\s+/)
    const q = Number(quota)
    const p = Number(period)
    if (quota !== 'max' && Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0) {
      return Math.max(1, Math.floor(q / p))
    }
  }

  try {
    return Math.max(1, os.cpus()?.length || 1)
  } catch {
    return 1
  }
})()

/** 자식 프로세스에 적용할 nice 값(0~19, 클수록 낮은 우선순위). env(AGENT_RUNNER_HEAVY_NICE) override. */
export const HEAVY_NICE = (() => {
  const v = Number(process.env.AGENT_RUNNER_HEAVY_NICE)
  return Number.isFinite(v) && v >= 0 && v <= 19 ? Math.floor(v) : 10
})()

// ── 메모리 여유 기반 admission (개수 세기의 대체) ────────────────────────────────

/**
 * 컨테이너 메모리 상한(bytes). cgroup v2 `memory.max`가 정본이며, `max`(무제한)이거나 읽을 수 없으면
 * `os.totalmem()`로 폴백한다. 둘 다 실패하면 null → admission은 no-op(fail-open).
 *
 * ⚠️ `os.totalmem()`은 `os.cpus()`와 같은 오보고 위험이 있다(호스트 전체를 보고할 수 있음). 그래서
 * 폴백일 뿐이고, 상한을 과대평가하면 "여유가 항상 충분"으로 판정돼 admission이 무해하게 비활성화된다
 * (과소평가해서 정상 작업을 막는 방향으로는 틀리지 않는다 — fail-open 설계).
 */
export const MEMORY_LIMIT_BYTES = (() => {
  const raw = readTrimmed(`${CGROUP_ROOT}/memory.max`)
  if (raw && raw !== 'max') {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  try {
    const total = os.totalmem()
    return Number.isFinite(total) && total > 0 ? total : null
  } catch {
    return null
  }
})()

/**
 * 새 도구를 띄우기 전 남겨 둘 최소 여유(bytes).
 *
 * `max(256MB, 상한의 10%)`. 256MB 근거: 러너 본체(Node)의 RSS가 통상 100~200MB이므로 그것을
 * 굶기지 않을 여유 + 슬랙. 10% 근거: 티어에 비례하게(4GB→410MB, 6GB→630MB, 8GB→819MB).
 * 절대값만 쓰면 큰 티어에서 너무 헐거워지고, 비율만 쓰면 작은 티어에서 러너 여유보다 작아진다.
 */
export const MIN_FREE_BYTES = (() => {
  const floor = 256 * 1024 * 1024
  if (MEMORY_LIMIT_BYTES === null) return floor
  return Math.max(floor, Math.floor(MEMORY_LIMIT_BYTES * 0.1))
})()

/** admission 대기 상한(ms). 이 시간을 넘기면 경고를 남기고 통과시킨다(fail-open). */
export const ADMIT_MAX_WAIT_MS = (() => {
  const v = Number(process.env.AGENT_RUNNER_ADMIT_MAX_WAIT_MS)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 10_000
})()

/** admission 폴링 주기(ms). */
const ADMIT_POLL_MS = 500

/** 누적 관측치 — /health·로그용. */
const admissionCounters = { admitted: 0, waited: 0, forced: 0, unavailable: 0 }

/**
 * 현재 사용 중 메모리(bytes). cgroup v2 `memory.current`가 정본, 실패 시 `os.totalmem()-os.freemem()`.
 * 둘 다 실패면 null.
 * @returns {number | null}
 */
export function currentMemoryBytes() {
  const raw = readTrimmed(`${CGROUP_ROOT}/memory.current`)
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  try {
    const used = os.totalmem() - os.freemem()
    return Number.isFinite(used) && used >= 0 ? used : null
  } catch {
    return null
  }
}

/**
 * 지금 새 도구를 띄울 메모리 여유가 있는지.
 * @returns {{ ok: boolean, freeBytes: number | null }} freeBytes=null이면 측정 불가(항상 ok)
 */
export function memoryHeadroom() {
  if (MEMORY_LIMIT_BYTES === null) return { ok: true, freeBytes: null }
  const used = currentMemoryBytes()
  if (used === null) return { ok: true, freeBytes: null }
  const free = MEMORY_LIMIT_BYTES - used
  return { ok: free >= MIN_FREE_BYTES, freeBytes: free }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 도구 실행 admission — 메모리 여유가 회복될 때까지 상한 있는 대기.
 *
 * 개수를 세지 않는 이유: 개수는 "몇 개가 무거운가"를 알아야 의미가 있고, 그건 명령 이름으로
 * 추측할 수밖에 없다(그 추측이 틀렸다는 것이 Wave 2의 출발점). 반면 "지금 메모리가 얼마 남았나"는
 * 추측이 아니라 사실이다.
 *
 * fail-open으로 끝내는 이유: 이 명령이 실제로 메모리를 얼마 쓸지 알 수 없으므로, 여유가 없다고
 * 거절하면 정상 작업을 막는 오판이 된다(작은 명령일 수도 있다). 대기로 pacing하고, 진짜 초과는
 * 커널이 `memory.high`/`memory.max`로 집행한다(`tool-cgroup.js`) — 그쪽은 실제 사용량을 보므로
 * 추측이 아니다. 역할 분담: **여기는 pacing, 커널은 enforcement.**
 *
 * @param {{ signal?: AbortSignal, readHeadroom?: () => { ok: boolean, freeBytes: number | null } }} [opts]
 *        readHeadroom은 테스트 주입용 — 기본값은 실제 cgroup 측정(`memoryHeadroom`).
 * @returns {Promise<{ admitted: boolean, waitedMs: number, forced: boolean, freeBytes: number | null }>}
 *          admitted=false는 abort된 경우뿐이다.
 */
export async function admitTool(opts = {}) {
  const readHeadroom = opts.readHeadroom ?? memoryHeadroom
  const startedAt = Date.now()
  let last = readHeadroom()

  if (last.freeBytes === null) {
    admissionCounters.unavailable++
    admissionCounters.admitted++
    return { admitted: true, waitedMs: 0, forced: false, freeBytes: null }
  }
  if (last.ok) {
    admissionCounters.admitted++
    return { admitted: true, waitedMs: 0, forced: false, freeBytes: last.freeBytes }
  }

  admissionCounters.waited++
  while (Date.now() - startedAt < ADMIT_MAX_WAIT_MS) {
    if (opts.signal?.aborted) {
      return { admitted: false, waitedMs: Date.now() - startedAt, forced: false, freeBytes: last.freeBytes }
    }
    await sleep(ADMIT_POLL_MS)
    last = readHeadroom()
    if (last.ok) {
      admissionCounters.admitted++
      return { admitted: true, waitedMs: Date.now() - startedAt, forced: false, freeBytes: last.freeBytes }
    }
  }

  // 대기 상한 초과 — 통과시킨다(fail-open). 호출자가 경고를 남긴다.
  admissionCounters.forced++
  admissionCounters.admitted++
  return { admitted: true, waitedMs: Date.now() - startedAt, forced: true, freeBytes: last.freeBytes }
}

/** admission 관측치 스냅샷 (/health·테스트용). */
export function admissionStats() {
  return {
    ...admissionCounters,
    vcpu: VCPU,
    memoryLimitBytes: MEMORY_LIMIT_BYTES,
    minFreeBytes: MIN_FREE_BYTES,
  }
}

/** 테스트용 카운터 초기화. */
export function _resetAdmissionCountersForTest() {
  admissionCounters.admitted = 0
  admissionCounters.waited = 0
  admissionCounters.forced = 0
  admissionCounters.unavailable = 0
}

// ── nice 래핑 ────────────────────────────────────────────────────────────────

let _nicePath // undefined=미확인, null=없음, string=경로
/**
 * `nice` 실행 파일 경로(존재 시). 없으면 null → 호출자는 nice 없이 실행.
 * silent failure(nice 미존재로 명령 자체가 실패) 방지 위해 spawn 대신 파일 존재로 확인.
 * @returns {string | null}
 */
export function nicePath() {
  if (_nicePath === undefined) {
    _nicePath = ['/usr/bin/nice', '/bin/nice'].find((p) => {
      try {
        return existsSync(p)
      } catch {
        return false
      }
    }) ?? null
  }
  return _nicePath
}

/**
 * spawn(cmd, args) 인자를 계산 — **에이전트가 실행하는 모든 자식 프로세스를 저우선으로** 감싼다.
 *
 * 이름 분기가 없다(Wave 1에서 제거, Wave 2에서 분류 자체가 삭제됨). 모듈 헤더 "왜 이름 목록을
 * 버렸나" 참조.
 *
 * 알려진 트레이드오프: 자식들끼리는 동등하다(종전엔 경량 0 > 무거움 10). 경량 명령의 응답성이
 * 실측으로 문제되면 처방은 이름 목록의 복원이 아니라 **점진 renice**(N초 넘게 도는 명령만 사후 강등
 * = 실측 기반)이며, 그건 포그라운드를 별도 프로세스 그룹으로 바꿔야 해서 별건으로 다룬다.
 *
 *  - nice 존재: ['/usr/bin/nice', ['-n', N, '/bin/bash', '-c', ...bashArgs]]
 *               (nice는 execvp로 bash를 대체 → pid 동일, kill 정상)
 *  - nice 없음: ['/bin/bash', ['-c', ...bashArgs]]  (폴백 — silent failure 방지)
 *
 * @param {string[]} bashArgs  '/bin/bash' 뒤에 올 인자(보통 ['-c', command])
 * @returns {{ file: string, args: string[] }}
 */
export function buildSpawnArgs(bashArgs) {
  const np = nicePath()
  if (np) {
    return { file: np, args: ['-n', String(HEAVY_NICE), '/bin/bash', ...bashArgs] }
  }
  return { file: '/bin/bash', args: [...bashArgs] }
}

/** 테스트용: 캐시된 nice 경로 판정 초기화. */
export function _resetNicePathCacheForTest() {
  _nicePath = undefined
}
