/**
 * remember tool — 에이전트가 사용자 지시·규칙·원칙을 영구 기억(durable memory)에 저장.
 *
 * 설계: daiops ADR 19(대화 메모리 캡처 — 단일 writer 수렴). web/Slack `/remember`와 동일한
 * cloud 정규 writer(updateMemory('instructions:core'))로 수렴한다.
 *
 * 동작 원칙:
 *  - 저장 자체는 **cloud가 수행**한다(파일 진실 + DB 미러 + writer 정책). runner는 저장하지 않는다.
 *  - 실행 로직(remember_request SSE 발신 → cloud updateMemory → 결과 수신)은 handler.js가
 *    onRemember 콜백으로 주입한다(request_secret과 동형 in-flight pause). 이 도구는 ApprovalManager/
 *    emitSse에 접근해야 하므로 runBuiltinTool 디스패치 밖에서 처리.
 *  - 저장된 규칙은 이후 모든 작업의 시스템 프롬프트에 항상 주입된다(instructions:core always-lane).
 */

/** 기억 본문 최대 길이 — cloud explicit-save 스키마(max 2000)와 정합. */
export const REMEMBER_CONTENT_MAX = 2000

/** Anthropic 호환 tool 정의 — llm-wrapper가 options.tools로 머지해 LLM에 노출. */
export const REMEMBER_TOOL = Object.freeze({
  name: 'remember',
  description:
    '사용자가 앞으로도 지켜야 할 지시·규칙·선호를 알려주거나("앞으로 ~해줘", "항상 ~", "기억해", "~를 잊지 마") ' +
    '명시적으로 일하는 방식을 정정할 때 호출해 영구 기억에 저장합니다. ' +
    '저장된 규칙은 이후 모든 작업의 시스템 프롬프트에 항상 반영됩니다. ' +
    '일회성 대화·맥락·작업 결과는 저장하지 마세요. 반복 적용할 지시·원칙만 한 줄씩 저장하세요.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          '기억할 규칙 한 줄. 명령형·구체적으로 작성 (예: "보고서는 항상 출처를 명시한다", "코드 변경 시 보안을 우선 점검한다").',
      },
    },
    required: ['content'],
  },
})

/**
 * cloud가 `POST /v1/remember/:id`로 보낼 수 있는 처리 결과 어휘.
 *
 * **cloud `daytona/agent-runner-approval.ts`의 `RememberAction`과 짝이다.** 값을 바꾸면 양쪽을
 * 함께 고쳐야 한다 — 러너가 이 문자열로 LLM 문구를 분기하기 때문. 인라인 배열로 두면 server.js와
 * onRemember에 사본이 흩어져 한쪽만 고치는 사고가 난다(QA #31·#64와 같은 실패 모드).
 *
 * `blocked`(정책 거부)는 `failed`(일시 장애)와 **반드시 구분**한다 — 구분하지 않으면 러너가
 * "잠시 후 다시 시도하세요"로 안내해 LLM이 남은 턴을 재시도로 태운다. 정책은 재시도해도 같다.
 */
export const REMEMBER_ACTIONS = Object.freeze(['saved', 'duplicate', 'failed', 'blocked'])

/** 실패류 — deny로 매핑되는 결과. duplicate는 "정상 처리됐고 결과가 이것"이라 실패가 아니다. */
export const REMEMBER_FAILURES = Object.freeze(['failed', 'blocked'])

/** cloud가 보낸 action이 계약상 유효한가. */
export function isRememberAction(action) {
  return REMEMBER_ACTIONS.includes(action)
}

/** 이 action을 deny(실패)로 다룰지. */
export function isRememberFailure(action) {
  return REMEMBER_FAILURES.includes(action)
}

/**
 * 기억 본문 유효성 검사 — 비어있지 않고 최대 길이 이내.
 * @param {unknown} content
 * @returns {boolean}
 */
export function isValidRememberContent(content) {
  if (typeof content !== 'string') return false
  const trimmed = content.trim()
  return trimmed.length > 0 && trimmed.length <= REMEMBER_CONTENT_MAX
}

/** blocked 의 종전 안내(cloud 가 안내를 보내지 않을 때). 옛 cloud 와 함께 돌 때 쓰인다 */
export const DEFAULT_BLOCKED_GUIDANCE =
  '이 대화 경로에서는 규칙을 영구 저장할 수 없어요. 사람이 직접 대화하는 채널에서 저장하거나, 사용자에게 설정 메뉴에서 등록하도록 안내하세요.'

/** cloud 가 보낸 안내의 상한(자). 도구 결과 한 문단이면 충분하고, 이상한 값이 와도 턴을 채우지 않게 자른다 */
export const GUIDANCE_MAX = 600

/**
 * POST /v1/remember/:id 본문 → 결정. 실패류(failed · blocked)는 kind 'deny', 나머지는 allow_once.
 * reason 은 blocked 의 사유(`unsafe_content` 등), guidance 는 cloud 가 사유에 맞춰 정한 안내다(11/05).
 * 안내를 cloud 가 들고 있어 문구를 바꿀 때 러너 릴리스가 필요 없다.
 */
export function rememberDecisionFromBody(action, body) {
  const blockedReason = typeof body?.reason === 'string' ? body.reason : null
  const guidance = typeof body?.guidance === 'string' && body.guidance.trim() ? body.guidance.trim().slice(0, GUIDANCE_MAX) : null
  return isRememberFailure(action)
    ? { kind: 'deny', rememberAction: action, blockedReason, guidance }
    : { kind: 'allow_once', rememberAction: action }
}

/** blocked 결과에 모델에게 돌려줄 안내. cloud 안내가 있으면 그것, 없으면 종전 문구 */
export function blockedRememberGuidance(result) {
  return typeof result?.guidance === 'string' && result.guidance ? result.guidance : DEFAULT_BLOCKED_GUIDANCE
}
