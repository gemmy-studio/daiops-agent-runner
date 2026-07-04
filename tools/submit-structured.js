/**
 * submit_structured_response tool — 외부 API 호출자가 response_schema(JSON Schema)를 주면
 * LLM이 그 형식으로만 최종 응답하도록 강제하는 가상 도구 (AGENT-API-2 구조화 출력).
 *
 * 설계:
 *  - Anthropic Messages API에는 벤더 output_config.format이 있으나 Claude 전용이라 fallback
 *    (Claude→GPT→Gemini)에서 깨진다. 그래서 provider 이식성이 있는 forced tool_choice로 구현:
 *    이 도구 하나만 tools에 넣고 tool_choice={type:'tool', name}으로 강제 → 모델이 반드시
 *    이 도구를 input=응답데이터로 호출한다.
 *  - 검증은 llm-wrapper의 runTool 분기에서 validate-schema로 수행. 실패 시 is_error tool_result를
 *    반환하면 기존 멀티턴 루프가 모델에 오류를 돌려주어 자기수정 재시도한다(신규 재시도 로직 불필요).
 *  - 검증 통과 시 turn-manager가 그 input(JSON)을 최종 응답으로 삼아 루프를 조기 종료한다.
 *
 * request-secret.js의 "input_schema 도구 + 전용 runTool 분기 + in-loop resolve" 패턴을 그대로 차용.
 *
 * 강제 시점(structuredMode, AGENT-API-5):
 *  - 'final_turn'(기본): open phase에서 다른 도구(Read/Bash/MCP wiki_read 등)를 자유롭게 쓰다가
 *    모델이 자연 종료(end_turn)하면 그때 1회 tool_choice로 이 도구를 강제한다 → "도구로 자료를
 *    수집한 뒤 구조화"가 가능. open phase에는 thinking도 활성이며, forcing turn에서만 thinking이
 *    자동 비활성화된다(thinking+forced tool_choice 400 회피).
 *  - 'immediate': turn 0부터 강제(단발 변환 — 제공된 입력을 스키마로 변환/분류/추출). 하위호환용.
 *  두 모드 모두 최종 출력이 순수 JSON이라 파싱이 결정론적으로 안전하다.
 */

export const STRUCTURED_TOOL_NAME = 'submit_structured_response'

/**
 * response_schema를 input_schema로 갖는 도구 정의를 생성.
 * @param {object} responseSchema - JSON Schema (object 루트 권장)
 * @returns {{ name: string, description: string, input_schema: object }}
 */
export function buildStructuredTool(responseSchema) {
  return {
    name: STRUCTURED_TOOL_NAME,
    description:
      '최종 답변을 이 도구로 제출하세요. input이 요구된 JSON 스키마에 정확히 부합해야 합니다. ' +
      '자유 텍스트로 답하지 말고 반드시 이 도구를 호출해 구조화된 결과만 반환하세요. ' +
      '검증에 실패하면 오류가 반환되며, 오류 내용을 반영해 스키마에 맞게 다시 제출하세요.',
    input_schema:
      responseSchema && typeof responseSchema === 'object'
        ? responseSchema
        : { type: 'object' },
  }
}
