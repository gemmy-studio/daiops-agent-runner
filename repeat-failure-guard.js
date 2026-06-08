/**
 * 반복 실패 회로 차단기 (openhuman tool_loop.rs `RepeatFailureGuard` 이식).
 *
 * 기존 handler.js의 REPEATED_TOOL_THRESHOLD 가드는 *연속 동일* 호출만 세고
 * 성공/실패를 구분하지 않아, `file → python → libreoffice → file …`처럼 입력을
 * 바꿔가며 전부 실패하는 루프(예: HWPX를 정식 도구 없이 변환 시도)를 놓친다.
 *
 * 이 가드는 두 가지를 추적한다:
 *   1) `(도구, 입력)` 서명별 누적 실패 횟수 — 같은 호출이 비연속으로 반복돼도 잡는다.
 *   2) 성공 없이 이어진 연속 실패 횟수 — 입력이 매번 달라도 진전이 없으면 잡는다(무진전).
 *
 * SDK(canUseTool) 모델에 맞춰, 루프 전체를 abort하는 대신 *해당 호출만 deny*하고
 * 근본 원인 메시지를 모델에 돌려준다 → 모델이 다른 접근으로 전환하거나 한계를
 * 보고할 수 있다(openhuman의 "do not retry; use an allowed alternative" 의도).
 *
 * 근거 캐시: ~/claude-references/.notes/ai-agent/openhuman/
 */

/** 같은 `(도구, 입력)`이 이만큼 실패하면, 똑같은 호출을 반복하는 것이므로 차단. */
export const REPEAT_FAILURE_THRESHOLD = 3
/** 성공 없이 연속으로 이만큼 실패하면(입력이 달라도) 진전이 없는 것이므로 차단. */
export const NO_PROGRESS_FAILURE_THRESHOLD = 6

export class RepeatFailureGuard {
  constructor() {
    /** @type {Map<string, number>} "도구|입력서명" → 실패 횟수 */
    this.sigCounts = new Map()
    /** 성공 없이 이어진 연속 실패 횟수 */
    this.consecutive = 0
  }

  /**
   * 도구 입력을 안정적인 서명 문자열로 변환. 순환 참조 등 직렬화 실패 시 빈 문자열.
   * @param {string} toolName
   * @param {unknown} input
   * @returns {string}
   */
  static signature(toolName, input) {
    let sig = ''
    try {
      sig = JSON.stringify(input) ?? ''
    } catch {
      sig = ''
    }
    return `${toolName}|${sig}`
  }

  /**
   * 도구 결과 1건을 기록. 성공이면 연속 실패 카운터를 리셋한다.
   * @param {string} toolName
   * @param {unknown} input
   * @param {boolean} success
   */
  record(toolName, input, success) {
    if (success) {
      this.consecutive = 0
      return
    }
    this.consecutive += 1
    const key = RepeatFailureGuard.signature(toolName, input)
    this.sigCounts.set(key, (this.sigCounts.get(key) ?? 0) + 1)
  }

  /**
   * 도구 실행 직전 검사. 차단해야 하면 모델에 돌려줄 한국어 사유 문자열을, 아니면 null을 반환.
   * canUseTool에서 호출 — 반환값이 있으면 deny로 처리한다.
   * @param {string} toolName
   * @param {unknown} input
   * @returns {string | null}
   */
  shouldBlock(toolName, input) {
    const key = RepeatFailureGuard.signature(toolName, input)
    const count = this.sigCounts.get(key) ?? 0
    if (count >= REPEAT_FAILURE_THRESHOLD) {
      return `이 도구(${toolName})를 같은 입력으로 ${count}번 시도했지만 모두 실패했어요. 같은 방식을 반복하면 안 돼요 — 다른 접근을 쓰거나, 이 환경에서 불가능하면 그렇다고 보고하세요.`
    }
    if (this.consecutive >= NO_PROGRESS_FAILURE_THRESHOLD) {
      return `도구 호출이 연속 ${this.consecutive}번 실패해 진전이 없어요. 지금 방식으로는 목표 달성이 어려워 보여요 — 접근을 바꾸거나, 안 되면 그렇다고 보고하세요.`
    }
    return null
  }
}
