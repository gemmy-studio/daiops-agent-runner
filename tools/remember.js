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
 * 기억 본문 유효성 검사 — 비어있지 않고 최대 길이 이내.
 * @param {unknown} content
 * @returns {boolean}
 */
export function isValidRememberContent(content) {
  if (typeof content !== 'string') return false
  const trimmed = content.trim()
  return trimmed.length > 0 && trimmed.length <= REMEMBER_CONTENT_MAX
}
