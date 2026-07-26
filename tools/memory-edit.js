/**
 * forget·revise tools — 에이전트가 자기 영구 기억(durable memory)을 **정리**한다.
 *
 * 설계: daiops ADR 31 "대체 방향" — 규칙에 출처(`[by:user]`/`[by:agent]`)와 보호 비트가 붙고,
 * 직원은 **자기가 넣은(또는 사용자가 열어준) 규칙만** 고치거나 지울 수 있다. 판정은 전부 cloud가
 * 한다 — 러너는 이름 목록도 권한 지식도 갖지 않는다(0.10.0 "순수 실행기" 원칙과 동형).
 *
 * 왜 필요한가: `remember`만 있어서 규칙이 **들어오기만** 했다. 2026-07-26 실측에서 한 워크스페이스에
 * 114줄이 쌓여 있었고 그중 절반이 평탄화된 작업 메모, 11줄이 거의 같은 규칙이었다. 매 대화의 시스템
 * 프롬프트에 통째로 주입되므로 쌓일수록 지시가 희석된다.
 *
 * 동작 원칙(remember와 동일):
 *  - 변경 자체는 **cloud가 수행**한다(파일 진실 + DB 미러 + writer 정책 + 스냅샷). runner는 저장하지 않는다.
 *  - 실행 로직(SSE 발신 → cloud 처리 → 결과 수신)은 handler.js가 onForget/onRevise 콜백으로 주입한다.
 *  - **사용자 결재를 걸지 않는다.** 30줄을 치우려면 30번 승인이 되어 자동 정리가 사실상 일어나지
 *    않는다. 보호 비트(cloud 판정)가 바닥을 막으므로, 열린 규칙만 자유롭게 정리하고 cloud가 변경 전
 *    전문을 스냅샷해 복구 경로를 남긴다.
 */

/** 규칙 본문 최대 길이 — remember(2000)와 정합. */
export const MEMORY_RULE_MAX = 2000

/** 한 줄 규칙 문자열 유효성 — 비어있지 않고 최대 길이 이내. */
export function isValidRuleText(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed.length <= MEMORY_RULE_MAX
}

/** Anthropic 호환 tool 정의 — llm-wrapper가 options.tools로 머지해 LLM에 노출. */
export const FORGET_TOOL = Object.freeze({
  name: 'forget',
  description:
    '영구 기억에 저장된 규칙 하나를 지웁니다. 더 이상 맞지 않게 된 규칙, 일회성 작업 메모가 규칙으로 ' +
    '잘못 저장된 것, 같은 내용이 여러 번 중복 저장된 것을 정리할 때 사용하세요. ' +
    '사용자가 직접 지정한 규칙은 보호되어 지워지지 않습니다(그 경우 그대로 두고 사용자에게 알리세요). ' +
    '규칙 본문을 시스템 프롬프트에 보이는 그대로 정확히 넘겨야 합니다.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '지울 규칙 한 줄. 시스템 프롬프트에 표시된 본문과 정확히 일치해야 합니다(날짜·태그는 제외).',
      },
    },
    required: ['content'],
  },
})

export const REVISE_TOOL = Object.freeze({
  name: 'revise',
  description:
    '영구 기억에 저장된 규칙 하나의 내용을 고칩니다. 규칙이 부분적으로만 틀렸을 때, 또는 거의 같은 ' +
    '규칙 여러 개를 더 정확한 하나로 합칠 때 사용하세요(합칠 때는 남길 규칙을 revise하고 나머지를 forget). ' +
    '사용자가 직접 지정한 규칙은 보호되어 수정되지 않습니다. 지우고 다시 저장하는 대신 이 도구를 ' +
    '쓰세요 — 중간에 실패해도 규칙이 사라지지 않습니다.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '고칠 대상 규칙 한 줄. 시스템 프롬프트에 표시된 본문과 정확히 일치해야 합니다.',
      },
      new_content: {
        type: 'string',
        description: '바꿀 새 내용 한 줄. 명령형·구체적으로 작성하세요.',
      },
    },
    required: ['content', 'new_content'],
  },
})

/**
 * cloud가 선언한 메모리 연산 목록에서 노출할 도구를 정한다.
 *
 * **하위호환이 이 함수의 존재 이유다.** 구버전 cloud는 `memory_ops`를 보내지 않고 `forget_request`
 * SSE를 처리할 줄도 모른다 — 그런 cloud에 도구를 노출하면 LLM이 호출한 뒤 결재 타임아웃(기본 10분)
 * 까지 매달린다. 미선언 시 `remember`만 노출해 **기존 동작을 정확히 보존**한다.
 *
 * @param {unknown} memoryOps cloud가 보낸 `memory_ops` (문자열 배열 기대)
 * @returns {{ forget: boolean, revise: boolean }}
 */
export function resolveMemoryOps(memoryOps) {
  const declared = Array.isArray(memoryOps) ? memoryOps.filter((v) => typeof v === 'string') : []
  return {
    forget: declared.includes('forget'),
    revise: declared.includes('revise'),
  }
}
