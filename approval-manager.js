/**
 * ApprovalManager — in-flight 결재 대기/해소.
 *
 * canUseTool 훅(T1)이 결재가 필요한 도구 호출 직전 waitForDecision으로 await,
 * cloud의 POST /v1/approval/:id(T3)가 resolve로 풀어준다.
 * pending 영속화는 T6 pending_approvals 테이블에서 처리(이 모듈은 메모리 Map만).
 *
 * 패턴: in-flight pause 결재 매니저 — waitForDecision으로 await, resolve로 해소.
 */

import { randomUUID } from 'node:crypto'

/** @typedef {'allow_once'|'allow_always'|'deny'} ApprovalDecisionKind */

/**
 * @typedef {object} ApprovalRequest
 * @property {string} toolName
 * @property {string} commandSummary
 * @property {string} reason
 * @property {string} [sessionId]
 * @property {string} [workspaceId]
 * @property {string} [sandboxId]
 * @property {string} [messageId]
 */

/**
 * @typedef {object} ApprovalDecision
 * @property {ApprovalDecisionKind} kind
 * @property {string} [allowlistEntry]  - allow_always 시 추가할 패턴 (Bash bin 또는 file_path)
 * @property {string} [feedback]        - deny 시 수정 지시(선택)
 * @property {'provide'|'skip'} [secretAction] - secret_request(Phase B) 해소 종류: 값 제공 또는 건너뛰기
 * @property {string} [value]           - secretAction='provide' 시 사용자가 입력한 secret 평문.
 *                                        agent-runner 내부 전용(process.env 주입). LLM/SSE에 절대 노출하지 않음.
 */

/**
 * @typedef {object} ApprovalRecord
 * @property {string} id
 * @property {ApprovalRequest} request
 * @property {number} createdAtMs
 * @property {number} expiresAtMs
 * @property {number} [resolvedAtMs]
 * @property {ApprovalDecision} [decision]
 * @property {string|null} [resolvedBy]
 */

export class ApprovalManager {
  constructor() {
    /** @type {Map<string, { record: ApprovalRecord, resolve: (d: ApprovalDecision|null) => void, timer: ReturnType<typeof setTimeout> }>} */
    this.pending = new Map()
  }

  /**
   * 결재 record 생성. 아직 pending Map에는 등록하지 않음 — waitForDecision 시점 등록.
   * id는 caller가 지정 가능(idempotency / DB 매칭용). 미지정 시 randomUUID.
   *
   * @param {ApprovalRequest} request
   * @param {number} timeoutMs
   * @param {string} [id]
   * @returns {ApprovalRecord}
   */
  create(request, timeoutMs, id) {
    const now = Date.now()
    const resolvedId = id && String(id).trim().length > 0 ? String(id).trim() : randomUUID()
    return {
      id: resolvedId,
      request,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    }
  }

  /**
   * 결재 결과 await. timeout 경과 시 null 반환 + Map 자동 정리.
   * resolve가 호출되면 즉시 decision 반환.
   *
   * @param {ApprovalRecord} record
   * @param {number} timeoutMs
   * @returns {Promise<ApprovalDecision|null>}
   */
  waitForDecision(record, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(record.id)
        resolve(null)
      }, timeoutMs)
      this.pending.set(record.id, { record, resolve, timer })
    })
  }

  /**
   * 외부에서 결재 결과 주입. 멱등 — 이미 resolve됐거나 없는 id는 false 반환.
   *
   * @param {string} recordId
   * @param {ApprovalDecision} decision
   * @param {string|null} [resolvedBy]
   * @returns {boolean} 성공 여부
   */
  resolve(recordId, decision, resolvedBy) {
    const entry = this.pending.get(recordId)
    if (!entry) return false
    clearTimeout(entry.timer)
    entry.record.resolvedAtMs = Date.now()
    entry.record.decision = decision
    entry.record.resolvedBy = resolvedBy ?? null
    this.pending.delete(recordId)
    entry.resolve(decision)
    return true
  }

  /**
   * 운영용 — 모든 pending id.
   *
   * @returns {string[]}
   */
  pendingIds() {
    return Array.from(this.pending.keys())
  }
}
