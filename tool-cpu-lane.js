/**
 * CPU-heavy tool concurrency lane — "정제-B"(박스 내부 CPU 레인 분리).
 *
 * 무거운 로컬 도구(문서 파서 CLI·코드 실행·설치 등)가 단일 코어 샌드박스를 CPU 포화시켜,
 * 같은 박스에서 동시에 진행 중인 다른 세션 turn의 SSE 스트리밍·경량 도구를 스톨시키는 것을 막는다.
 * (concurrency-gate.ts가 관측·기록한 "1코어 CPU 100%·잦게 꺼졌다 켜졌다"의 도구 레벨 방어.)
 *
 * 정책:
 *  - I/O·경량 도구(Read/Grep/Glob/Edit/네트워크, 짧은 Bash)는 이 레인을 통과하지 않는다(무제한).
 *  - CPU 무거운 Bash 명령만 레인(유계 세마포어)을 획득하고 `nice`로 우선순위를 낮춰 실행한다.
 *  - 레인 크기는 샌드박스 vCPU 수에서 파생: floor(vCPU/2) (small 1c→1, med 2c→1, large 4c→2).
 *    → cloud 티어 config를 프로세스로 배선하지 않아도 tier에 자동 정렬. env override 지원.
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
 * 무거운(CPU 집약) Bash 명령 판별.
 *
 * 설계 원칙: 과분류(경량을 heavy로)는 그저 직렬화+저우선일 뿐이라 안전하고, 과소분류(heavy를 놓침)가
 * 위험하므로 알려진 무거운 경로를 넓게 잡되, 흔한 경량 명령(ls/cat/git status/echo 등)은 매칭되지 않도록 특정한다.
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
 * heavy 여부에 따라 spawn(cmd, args) 인자를 계산.
 *  - 경량: ['/bin/bash', ['-c', ...bashArgs]]
 *  - 무거움 + nice 존재: ['/usr/bin/nice', ['-n', N, '/bin/bash', '-c', ...bashArgs]]  (nice는 execvp로 bash를 대체 → pid 동일, kill 정상)
 *  - 무거움 + nice 없음: ['/bin/bash', ['-c', ...bashArgs]]  (세마포어만으로 방어)
 *
 * @param {boolean} heavy
 * @param {string[]} bashArgs  '/bin/bash' 뒤에 올 인자(보통 ['-c', command])
 * @returns {{ file: string, args: string[] }}
 */
export function buildSpawnArgs(heavy, bashArgs) {
  const np = heavy ? nicePath() : null
  if (heavy && np) {
    return { file: np, args: ['-n', String(HEAVY_NICE), '/bin/bash', ...bashArgs] }
  }
  return { file: '/bin/bash', args: [...bashArgs] }
}

/** 테스트용: 캐시된 nice 경로 판정 초기화. */
export function _resetNicePathCacheForTest() {
  _nicePath = undefined
}
