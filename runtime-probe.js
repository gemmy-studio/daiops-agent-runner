/**
 * 샌드박스 런타임 자원 실측 (Wave 1 — 관측).
 *
 * 왜 필요한가: `tool-cpu-lane.js`는 레인 크기를 `os.cpus()`에서 파생하면서 "cloud 티어 config를
 * 배선하지 않아도 tier에 자동 정렬된다"고 가정한다. 그런데 **Node의 `os.cpus()`는 cgroup CPU 한도를
 * 보지 않고 호스트 코어 수를 반환하는 것이 컨테이너 런타임의 일반적 동작**이다. 그 경우 small(1 vCPU)
 * 샌드박스에서 `floor(os.cpus()/2)`가 1이 아니라 8이 되어 레인이 사실상 무력화된다 — 그런데 이건
 * 로그에도 에러에도 드러나지 않는다(조용한 실패).
 *
 * 그래서 판정 근거를 **`/health`로 밖에 내보낸다**. cloud가 티어값과 비교해 불일치를 경고하면
 * 샌드박스에 셸로 들어가지 않고도 프로덕션 전수에서 진위를 알 수 있다.
 *
 * 함께 재는 것: cgroup **쓰기 위임 여부**. 컨테이너에서 `/sys/fs/cgroup`은 읽기만 허용되는 경우가
 * 많고, 쓰기가 되는지는 실제로 써 봐야 안다. 이 값이 Wave 3(커널 집행: cpu.max·memory.max)의
 * 진행 가능 여부를 결정한다.
 *
 * 설계 원칙: **모든 읽기는 실패해도 되고, 실패는 null이다.** 이 모듈이 던지면 /health가 죽고
 * 그러면 cloud 핸드셰이크가 깨져 샌드박스가 재시작 루프에 빠진다 — 관측 코드가 가용성을 해치는
 * 최악의 형태다. 그래서 전 경로 try/catch + 동기 fs(부팅 1회라 비용 무의미).
 */

import os from 'node:os'
import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'

/** cgroup 마운트 루트. cgroup v2 단일 계층이면 이 경로에 `cgroup.controllers`가 있다. */
const CGROUP_ROOT = '/sys/fs/cgroup'

/** 쓰기 위임 시험용 임시 서브그룹 이름. 시험 후 즉시 제거한다. */
const PROBE_GROUP = `${CGROUP_ROOT}/daiops-probe`

/** 파일을 읽어 trim한 문자열. 없거나 실패면 null. */
function readTrimmed(path) {
  try {
    return readFileSync(path, 'utf-8').trim()
  } catch {
    return null
  }
}

/**
 * cgroup 계층 버전 판별.
 *  - 'v2': `/sys/fs/cgroup/cgroup.controllers` 존재 (단일 계층)
 *  - 'v1': v2 파일은 없고 `/sys/fs/cgroup/cpu` 서브디렉토리 존재 (레거시 다중 계층)
 *  - null: 판별 불가(마운트 안 됨)
 * @returns {'v2' | 'v1' | null}
 */
export function detectCgroupVersion() {
  try {
    if (existsSync(`${CGROUP_ROOT}/cgroup.controllers`)) return 'v2'
    if (existsSync(`${CGROUP_ROOT}/cpu`)) return 'v1'
  } catch {
    /* 판별 실패 = null */
  }
  return null
}

/**
 * cgroup v2 `cpu.max`("<quota> <period>" 또는 "max <period>")에서 유효 vCPU 수를 계산.
 * quota가 'max'(무제한)면 null — 호출자가 다른 근거로 폴백해야 한다.
 *
 * 예: "200000 100000" → 2.0 vCPU
 * @param {string | null} raw
 * @returns {number | null}
 */
export function parseCpuMax(raw) {
  if (!raw) return null
  const [quota, period] = raw.split(/\s+/)
  if (!quota || quota === 'max') return null
  const q = Number(quota)
  const p = Number(period)
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0 || q <= 0) return null
  return q / p
}

/**
 * cgroup 쓰기 위임 여부를 **실제로 써서** 확인한다.
 *
 * `existsSync`나 `access(W_OK)`로는 부족하다 — 컨테이너에서 루트 디렉토리는 쓰기 가능해 보이는데
 * 서브그룹 생성이 커널/런타임 정책에 막히는 경우가 있어, mkdir을 시도하는 것만이 결정적이다.
 * 성공하면 즉시 rmdir로 되돌린다(부작용 0).
 *
 * @returns {boolean}
 */
export function probeCgroupWritable() {
  let created = false
  try {
    if (detectCgroupVersion() !== 'v2') return false
    mkdirSync(PROBE_GROUP)
    created = true
    // mkdir이 됐어도 컨트롤러 인터페이스 파일에 쓸 수 있는지는 별개다. cpu.weight 쓰기까지 확인.
    try {
      const current = readTrimmed(`${PROBE_GROUP}/cpu.weight`)
      if (current !== null) writeFileSync(`${PROBE_GROUP}/cpu.weight`, current)
    } catch {
      return false
    }
    return true
  } catch {
    return false
  } finally {
    if (created) {
      try {
        rmdirSync(PROBE_GROUP)
      } catch {
        /* 정리 실패는 무해 — 다음 부팅의 mkdir가 EEXIST로 실패해 false가 되므로 보수적 */
      }
    }
  }
}

/**
 * `/health`에 실을 런타임 실측 스냅샷.
 *
 * cloud는 이 중 `osCpus`를 워크스페이스 티어의 `cpu`와 비교해 불일치를 경고하고,
 * `cgroupWritable`로 Wave 3 진행 가능 여부를 판정한다.
 *
 * @returns {{
 *   osCpus: number | null,
 *   envVcpu: number | null,
 *   cgroupVersion: 'v2' | 'v1' | null,
 *   cpuMax: string | null,
 *   cpuMaxVcpu: number | null,
 *   cpuWeight: string | null,
 *   memoryMax: string | null,
 *   memoryCurrent: string | null,
 *   cgroupWritable: boolean,
 *   totalMemMb: number | null,
 * }}
 */
export function collectRuntimeProbe() {
  let osCpus = null
  try {
    osCpus = os.cpus()?.length ?? null
  } catch {
    osCpus = null
  }

  let totalMemMb = null
  try {
    totalMemMb = Math.round(os.totalmem() / (1024 * 1024))
  } catch {
    totalMemMb = null
  }

  const envRaw = Number(process.env.AGENT_RUNNER_VCPU)
  const envVcpu = Number.isFinite(envRaw) && envRaw > 0 ? envRaw : null

  const cgroupVersion = detectCgroupVersion()
  const cpuMax = cgroupVersion === 'v2' ? readTrimmed(`${CGROUP_ROOT}/cpu.max`) : null

  return {
    osCpus,
    envVcpu,
    cgroupVersion,
    cpuMax,
    cpuMaxVcpu: parseCpuMax(cpuMax),
    cpuWeight: cgroupVersion === 'v2' ? readTrimmed(`${CGROUP_ROOT}/cpu.weight`) : null,
    memoryMax: cgroupVersion === 'v2' ? readTrimmed(`${CGROUP_ROOT}/memory.max`) : null,
    memoryCurrent: cgroupVersion === 'v2' ? readTrimmed(`${CGROUP_ROOT}/memory.current`) : null,
    cgroupWritable: probeCgroupWritable(),
    totalMemMb,
  }
}
