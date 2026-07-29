/**
 * CPU-heavy tool concurrency lane — "정제-B"(박스 내부 CPU 레인 분리).
 *
 * 무거운 로컬 도구(문서 파서 CLI·코드 실행·설치 등)가 단일 코어 샌드박스를 CPU 포화시켜,
 * 같은 박스에서 동시에 진행 중인 다른 세션 turn의 SSE 스트리밍·경량 도구를 스톨시키는 것을 막는다.
 * (concurrency-gate.ts가 관측·기록한 "1코어 CPU 100%·잦게 꺼졌다 켜졌다"의 도구 레벨 방어.)
 *
 * 정책 (Wave 1, 2026-07-29 개정):
 *  - **우선순위**: Bash가 띄우는 *모든* 자식 프로세스를 `nice`로 감싼다(이름 분기 없음 —
 *    `buildSpawnArgs` 주석 참조). 러너 본체가 자식보다 항상 우선한다는 불변식만 세운다.
 *  - **개수**: CPU 무거운 것으로 *분류된* Bash 명령만 유계 세마포어를 획득한다. 이 분류는
 *    이름 기반이라 새며(아래 ⚠️), Wave 2에서 측정 기반(cgroup memory 여유)으로 교체 예정이다.
 *  - I/O·경량 도구(Read/Grep/Glob/Edit/네트워크)는 세마포어를 통과하지 않는다(무제한).
 *  - 레인 크기는 샌드박스 vCPU 수에서 파생: floor(vCPU/2) (small 1c→1, med 2c→1, large 4c→2).
 *    ⚠️ **파생 근거인 `os.cpus()`가 컨테이너 CPU 한도를 반영하는지 미검증**이다 — 호스트 코어 수를
 *    반환하면 레인이 의도보다 훨씬 커져 무력화된다. Wave 1이 `/health.runtime`으로 실측을 내보내고
 *    (`runtime-probe.js`), Wave 2가 `AGENT_RUNNER_VCPU`(cloud 티어 배선) 우선으로 교체한다.
 *
 * 레퍼런스: hermes `_ThreadedProcessHandle`/`subprocess.Popen`, vellum `runWithConcurrency`(유계 fan-out),
 *          OpenHands SDK(공유 컨테이너 리소스 고갈 경고), chat-progress §-5 워크스페이스 동시성 하드닝.
 *          업계 관행: heavy stateless work는 별도 샌드박스가 아니라 같은 박스 내 유계·저우선 실행(Cloud Run
 *          per-instance concurrency + co-process nice/cgroup). 별도 박스 증설은 영속 정체성과 상충하여 미채택.
 */

import os from 'node:os'
import { existsSync } from 'node:fs'

/** 무거운 도구 동시 실행 상한. env(AGENT_RUNNER_MAX_HEAVY_TOOLS) > vCPU 파생 > 1. */
export const MAX_HEAVY_TOOLS = (() => {
  const env = Number(process.env.AGENT_RUNNER_MAX_HEAVY_TOOLS)
  if (Number.isFinite(env) && env >= 1) return Math.floor(env)
  let cpus = 1
  try {
    cpus = os.cpus()?.length || 1
  } catch {
    cpus = 1
  }
  return Math.max(1, Math.floor(cpus / 2))
})()

/** 무거운 명령에 적용할 nice 값(0~19, 클수록 낮은 우선순위). env(AGENT_RUNNER_HEAVY_NICE) override. */
export const HEAVY_NICE = (() => {
  const v = Number(process.env.AGENT_RUNNER_HEAVY_NICE)
  return Number.isFinite(v) && v >= 0 && v <= 19 ? Math.floor(v) : 10
})()

/**
 * 무거운(CPU 집약) Bash 명령 판별 — **세마포어 슬롯 획득 여부에만** 쓰인다(우선순위는 전면 nice).
 *
 * ⚠️ **이 목록은 양방향으로 틀리며, 그걸 알고 남겨 둔 것이다.**
 *  - 누락(실측): `make`·`bash x.sh`·`./x.sh`·`gcc`·`cargo build`·`npm run build`·`uv run x.py`·
 *    `tesseract`·`pandoc`·`pdftoppm`·`tar/zip/7z`·`sqlite3`·`python3 -c '<루프>'`(의도적 제외).
 *  - 오탐(실측): 패턴 5의 `\bconvert\b`가 너무 넓어 `git commit -m "convert to md"`가 heavy로
 *    잡힌다(`libreoffice --convert-to`가 걸리는 것도 이 우연 덕이다). 레인 크기가 1인 티어에서는
 *    사소한 git 커밋이 유일한 슬롯을 점유하므로 "과분류는 안전"이 성립하지 않는다.
 *
 * 사용자가 만든 스킬은 `SKILL.md` 마크다운이라 그 자체가 분류 대상이 될 수 없고, 스킬이 *유도한*
 * 명령만 여기 걸리므로 "스킬이 생길 때마다 패턴을 추가해야 하는" 관계가 구조적으로 성립한다
 * → 유지 불가능. Wave 2에서 이 함수와 `HEAVY_PATTERNS`를 삭제하고 측정 기반 admission으로 교체한다.
 * 그때까지 오분류의 영향은 **개수 제한**에 한정된다(우선순위는 전면 nice가 이름 없이 보장).
 *
 * 설계 원칙(현행): 과분류(경량을 heavy로)는 직렬화 비용만 있어 안전하고, 과소분류가 위험하므로
 * 알려진 무거운 경로를 넓게 잡되, 흔한 경량 명령(ls/cat/git status/echo 등)은 매칭되지 않도록 특정한다.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isHeavyCommand(command) {
  if (typeof command !== 'string' || !command) return false
  return HEAVY_PATTERNS.some((re) => re.test(command))
}

const HEAVY_PATTERNS = [
  // baked 문서 파서 CLI (document-core / document-hwp / document-image).
  /\/opt\/document-[a-z]+\/cli\.js\b/,
  // 위키 인덱싱 CLI (agent-runner Bash 경유 시. cloud 직접 경로는 import-document.ts에서 별도 nicing).
  /\bwiki[_-]?import\b/,
  // 인터프리터로 스크립트 파일 실행(장기 CPU 가능). REPL 단발(-c)·버전체크는 제외.
  /\b(?:python3?|node|ts-node|deno)\s+[^|;&]*\.(?:py|js|mjs|cjs|ts)\b/,
  // 패키지 설치(CPU+네트워크 집약).
  /\b(?:pip3?|npm|pnpm|yarn|uv)\s+(?:install|add|ci)\b/,
  // 미디어·이미지 변환(CPU 집약).
  /\b(?:ffmpeg|convert|magick|gs|gswin)\b/,
]

/**
 * 최소 FIFO async 세마포어. 슬롯 핸드오버 방식(release 시 대기자에게 슬롯을 직접 넘겨 active 카운트가
 * 순간적으로 max를 초과하지 않도록 보장).
 */
class Semaphore {
  /** @param {number} max */
  constructor(max) {
    this._max = Math.max(1, Math.floor(max) || 1)
    this._active = 0
    /** @type {Array<() => void>} */
    this._waiters = []
  }

  /** @returns {Promise<() => void>} release 함수(멱등) */
  acquire() {
    if (this._active < this._max) {
      this._active++
      return Promise.resolve(this._makeRelease())
    }
    return new Promise((resolve) => this._waiters.push(resolve)).then(() => this._makeRelease())
  }

  _makeRelease() {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this._waiters.shift()
      if (next) {
        // 슬롯을 대기자에게 직접 넘김 — active 유지(감소 후 재증가 사이 race로 max 초과 방지).
        next()
      } else {
        this._active--
      }
    }
  }

  stats() {
    return { active: this._active, waiting: this._waiters.length, max: this._max }
  }
}

const heavyLane = new Semaphore(MAX_HEAVY_TOOLS)

/**
 * 무거운 도구 레인 슬롯 획득. 반환된 release()를 finally에서 정확히 1회 호출해야 한다.
 * @returns {Promise<() => void>}
 */
export function acquireHeavyLane() {
  return heavyLane.acquire()
}

/** 레인 관찰(테스트·Phase 3 포화 감지용). */
export function heavyLaneStats() {
  return heavyLane.stats()
}

let _nicePath // undefined=미확인, null=없음, string=경로
/**
 * `nice` 실행 파일 경로(존재 시). 없으면 null → 호출자는 nice 없이 실행(세마포어만으로 방어).
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
 * ⚠️ Wave 1(2026-07-29)에서 `heavy` 분기를 제거했다. 종전에는 `isHeavyCommand`가 참인 명령만
 * nice로 감쌌는데, 그 이름 목록에 없는 CPU 집약 명령(`bash x.sh`·`make`·`libreoffice`·`pdftoppm`·
 * `python3 -c '<루프>'` 등 10종 이상)이 **nice 0으로 실행돼, 올바르게 분류된 무거운 명령(nice 10)을
 * 이기는 뒤집힌 상태**였다. 이름 목록은 원리적으로 새므로(사용자 스킬이 매주 새 명령을 만든다)
 * 분기 자체를 없앴다 — cf. `handler.js` P3의 "이름을 모르는 규칙" 판단과 같은 방향.
 *
 * 왜 안전한가: nice는 **CPU가 남을 때 아무 영향이 없다**(경합 시에만 양보). 따라서 경량 명령의
 * 절대 속도는 변하지 않고, 러너 본체(nice 0 — SSE 스트리밍·경량 도구 디스패치)가 자식들보다
 * 항상 우선한다는 불변식만 얻는다.
 *
 * 알려진 트레이드오프: 자식들끼리는 이제 동등하다(종전엔 경량 0 > 무거움 10). 경량 명령의 응답성이
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
