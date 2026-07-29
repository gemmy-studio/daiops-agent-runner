/**
 * 도구 전용 cgroup v2 서브그룹 — **커널이 집행하는** 자원 상한 (Wave 3).
 *
 * `tool-cpu-lane.js`는 러너가 *스스로 자제*하는 계층이다(nice + 메모리 여유 pacing). 그 방식의
 * 한계는 자제가 부탁이라는 점이다 — 자식 프로세스가 실제로 얼마를 쓰는지는 사후에만 알 수 있고,
 * 러너 자신이 OOM 대상이 될 수도 있다. 이 모듈은 그 위에 **물리적 상한**을 얹는다:
 * 도구 자식들을 별도 cgroup에 넣고 `cpu.weight`·`memory.high`·`memory.max`를 커널에 맡긴다.
 *
 * ## 왜 이 방향인가
 *
 * 조사한 레퍼런스 중 명령 이름으로 CPU 무게를 분류하는 구현은 없었고, openclaw는 컨테이너 자원
 * 한도(`cpus`·`memory`·`pidsLimit`·`ulimits`)를 설정으로 노출한다. 업계 표준은 cgroup v2
 * `cpu.max`/`cpu.weight` — 이름을 몰라도 되는 계층에서 집행하는 것이다. `nice`보다 `cpu.weight`가
 * 권고되는 이유는 스케일링이 명확하고(1~10000, 기본 100) 그룹 단위로 관리되기 때문이다.
 *
 * ## 안전 설계 — 실패는 전부 "비활성"으로 수렴한다
 *
 * cgroup 쓰기는 환경에 달려 있다. 컨테이너에서 `/sys/fs/cgroup`은 읽기만 허용되는 경우가 많고,
 * cgroup v2의 "no internal processes" 규칙 때문에 non-root 그룹에서 `subtree_control`을 켜면
 * EBUSY로 실패한다(루트 그룹은 이 규칙에서 면제). 그래서:
 *
 *  - 모든 단계가 try/catch이고, 어느 단계든 실패하면 **비활성으로 확정**하고 다시 시도하지 않는다.
 *  - 비활성이어도 기능은 그대로다 — nice와 메모리 pacing이 계속 동작한다(성능만 덜 보장).
 *  - 판정 결과는 `toolCgroupState()`로 `/health`에 노출해 조용한 실패를 막는다.
 *
 * ## 알려진 한계 — attach 경합
 *
 * 자식 pid를 spawn *직후* 기록하므로, bash가 그 사이에 손자를 fork하면 그 손자는 서브그룹 밖에
 * 남는다(cgroup 멤버십은 fork 시점에 상속된다). 창은 밀리초 수준이고, `bash -c '<단일 명령>'`은
 * bash가 exec로 대체되어 pid가 곧 명령이라 실무적으로 대부분 덮인다. 그리고 **놓친 손자도 nice는
 * 유지한다**(niceness도 fork 시 상속되며 그건 spawn 인자로 이미 박혀 있다) — 즉 최악의 경우
 * "이 프로세스만 메모리 상한 밖"이고 우선순위 보호는 남는다.
 *
 * 명령 문자열에 `echo $$ > cgroup.procs`를 심으면 손자까지 완전히 덮이지만, 그러려면 백그라운드
 * 경로의 종료코드 sentinel 래퍼와 kill 경로를 함께 손봐야 해서 회귀 위험이 크다. 실측으로 누락이
 * 문제가 되면 그때 별건으로 다룬다.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmdirSync,
  existsSync,
} from 'node:fs'
import { VCPU, MEMORY_LIMIT_BYTES } from './tool-cpu-lane.js'

const CGROUP_ROOT = '/sys/fs/cgroup'

/** 도구 자식들을 담을 서브그룹. */
const TOOL_GROUP = `${CGROUP_ROOT}/daiops-tools`

/**
 * 도구 그룹의 CPU 가중치. 기본 100 대비 낮게 둬서 경합 시 러너 본체(루트 그룹, 기본 100)가
 * 우선하게 한다. 20 = 대략 1/5 몫 — nice 10과 같은 방향의 개입을 커널 계층에서 재확인한다.
 * env(AGENT_RUNNER_TOOL_CPU_WEIGHT) override.
 */
const TOOL_CPU_WEIGHT = (() => {
  const v = Number(process.env.AGENT_RUNNER_TOOL_CPU_WEIGHT)
  return Number.isFinite(v) && v >= 1 && v <= 10_000 ? Math.floor(v) : 20
})()

/**
 * 도구 그룹의 메모리 상한 비율.
 *  - `memory.high`(60%): **소프트** 상한. 넘으면 커널이 회수 압력을 걸어 프로세스를 *느리게* 한다
 *    (죽이지 않는다). 이게 우리가 원하는 1차 개입 — 폭주를 감속시키되 작업은 완료된다.
 *  - `memory.max`(80%): **하드** 상한. 넘으면 이 그룹 안에서 OOM kill이 일어난다. 핵심은 희생자가
 *    **도구 자식**으로 한정된다는 것 — 종전에는 컨테이너 전역 OOM이라 러너 본체가 죽을 수 있었고,
 *    그러면 진행 중인 모든 세션이 함께 날아갔다.
 * 20%를 러너 본체·MCP 서버·시스템에 남긴다.
 */
const MEMORY_HIGH_RATIO = 0.6
const MEMORY_MAX_RATIO = 0.8

/** @type {{ enabled: boolean, reason: string | null, cpuWeight: number | null, memoryHigh: number | null, memoryMax: number | null, attached: number, attachFailed: number }} */
const state = {
  enabled: false,
  reason: null,
  cpuWeight: null,
  memoryHigh: null,
  memoryMax: null,
  attached: 0,
  attachFailed: 0,
}

let initialized = false

function read(path) {
  try {
    return readFileSync(path, 'utf-8').trim()
  } catch {
    return null
  }
}

/**
 * 부모 그룹의 `cgroup.subtree_control`에 컨트롤러를 위임한다.
 * 이미 켜져 있으면 아무것도 쓰지 않는다(불필요한 쓰기로 EBUSY를 유발하지 않게).
 * @param {string[]} controllers
 * @returns {string | null} 실패 사유(성공이면 null)
 */
function enableControllers(controllers) {
  const available = read(`${CGROUP_ROOT}/cgroup.controllers`)
  if (!available) return 'cgroup.controllers 없음(v2 아님)'

  const missing = controllers.filter((c) => !available.split(/\s+/).includes(c))
  if (missing.length > 0) return `컨트롤러 미제공: ${missing.join(',')}`

  const current = read(`${CGROUP_ROOT}/cgroup.subtree_control`) ?? ''
  const enabled = new Set(current.split(/\s+/).filter(Boolean))
  const toAdd = controllers.filter((c) => !enabled.has(c))
  if (toAdd.length === 0) return null

  try {
    writeFileSync(`${CGROUP_ROOT}/cgroup.subtree_control`, toAdd.map((c) => `+${c}`).join(' '))
    return null
  } catch (err) {
    // EBUSY = "no internal processes" 규칙(루트가 아닌 그룹에 프로세스가 있는 채로 위임 시도).
    return `subtree_control 쓰기 실패: ${err?.code ?? err?.message ?? 'unknown'}`
  }
}

/**
 * 도구 서브그룹을 생성하고 자원 상한을 설정한다. **부팅 1회, 멱등.**
 * 실패는 비활성으로 확정한다(재시도 없음 — 환경 제약은 런타임에 바뀌지 않는다).
 * @returns {typeof state}
 */
export function initToolCgroup() {
  if (initialized) return state
  initialized = true

  try {
    if (!existsSync(`${CGROUP_ROOT}/cgroup.controllers`)) {
      state.reason = 'cgroup v2 미마운트'
      return state
    }

    // 순서 주의: **mkdir을 먼저** 시도한다. `subtree_control` 쓰기는 컨테이너 *전역*에 영향을 주는
    // 변경이므로, 서브그룹조차 만들 수 없는 환경(대부분의 non-root 컨테이너 — EACCES)에서 부모를
    // 먼저 건드리면 얻는 것 없이 남의 상태를 바꾸게 된다.
    let createdHere = false
    if (!existsSync(TOOL_GROUP)) {
      try {
        mkdirSync(TOOL_GROUP)
        createdHere = true
      } catch (err) {
        state.reason = `서브그룹 생성 실패: ${err?.code ?? err?.message ?? 'unknown'}`
        return state
      }
    }

    const ctlErr = enableControllers(['cpu', 'memory'])
    if (ctlErr) {
      state.reason = ctlErr
      // 이번 부팅에서 만든 빈 그룹은 되돌린다(고아 디렉토리 방치 금지).
      if (createdHere) {
        try {
          rmdirSync(TOOL_GROUP)
        } catch {
          /* 정리 실패는 무해 — 비어 있고 아무 프로세스도 들어가지 않는다 */
        }
      }
      return state
    }

    // cpu.weight — 경합 시 몫. 실패하면 비활성(부분 적용 상태로 두지 않는다).
    try {
      writeFileSync(`${TOOL_GROUP}/cpu.weight`, String(TOOL_CPU_WEIGHT))
      state.cpuWeight = TOOL_CPU_WEIGHT
    } catch (err) {
      state.reason = `cpu.weight 쓰기 실패: ${err?.code ?? err?.message ?? 'unknown'}`
      return state
    }

    // memory.high/max — 상한을 모르면(무제한 컨테이너) 메모리는 건너뛰고 CPU만 적용한다.
    if (MEMORY_LIMIT_BYTES !== null) {
      const high = Math.floor(MEMORY_LIMIT_BYTES * MEMORY_HIGH_RATIO)
      const max = Math.floor(MEMORY_LIMIT_BYTES * MEMORY_MAX_RATIO)
      try {
        writeFileSync(`${TOOL_GROUP}/memory.high`, String(high))
        state.memoryHigh = high
      } catch {
        /* memory.high 실패는 치명 아님 — max만으로도 러너 보호는 성립한다 */
      }
      try {
        writeFileSync(`${TOOL_GROUP}/memory.max`, String(max))
        state.memoryMax = max
      } catch {
        /* 동상 — CPU 가중치만으로 계속 */
      }
    }

    state.enabled = true
    state.reason = null
    return state
  } catch (err) {
    state.reason = `초기화 예외: ${err instanceof Error ? err.message : String(err)}`
    return state
  }
}

/**
 * 자식 프로세스를 도구 서브그룹에 편입한다.
 *
 * 비활성이거나 pid가 유효하지 않으면 no-op. 실패는 카운터만 올리고 조용히 넘긴다 — 이미 죽은
 * 짧은 명령(ESRCH)이 정상적인 실패 사유라서 로그를 남기면 소음이 된다.
 *
 * @param {number | undefined} pid
 * @returns {boolean} 편입 성공 여부
 */
export function attachToToolCgroup(pid) {
  if (!state.enabled) return false
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    writeFileSync(`${TOOL_GROUP}/cgroup.procs`, String(pid))
    state.attached++
    return true
  } catch {
    state.attachFailed++
    return false
  }
}

/** 현재 상태 스냅샷 (/health·테스트용). 조용한 실패 방지를 위해 reason을 항상 실어 보낸다. */
export function toolCgroupState() {
  return {
    ...state,
    vcpu: VCPU,
    group: TOOL_GROUP,
  }
}

/** 테스트용 초기화 — 부팅 1회 가드를 되돌린다. */
export function _resetToolCgroupForTest() {
  initialized = false
  state.enabled = false
  state.reason = null
  state.cpuWeight = null
  state.memoryHigh = null
  state.memoryMax = null
  state.attached = 0
  state.attachFailed = 0
}
