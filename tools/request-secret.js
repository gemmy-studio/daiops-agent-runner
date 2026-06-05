/**
 * request_secret tool — 에이전트가 작업에 필요한 환경변수(API 키·토큰)를 사용자에게 안전하게 요청.
 *
 * 설계: daiops Phase B(에이전트 주도 ENV/Secret 채팅 요청). OpenHuman mcp_setup_request_secret 차용.
 *
 * 보안 원칙:
 *  - 값(평문)은 **모델에 절대 노출되지 않는다**. 도구 결과는 "$KEY_NAME 사용 가능" 핸들만 반환.
 *  - 실제 값은 agent-runner 본체 process.env가 아닌 *세션 secret Map*에만 저장되고, getToolEnv →
 *    buildToolEnv로 Bash 등 자식 프로세스 env에만 주입된다(본체 env 불변·OpenHuman 격리).
 *  - 실행 로직(결재 대기·secret 주입)은 handler.js가 onRequestSecret 콜백으로 주입한다.
 *    (이 도구는 ApprovalManager/emitSse/세션 secret store에 접근해야 하므로 runBuiltinTool 디스패치 밖에서 처리.)
 */

/** 환경변수 키 규칙 — cloud workspace_secrets KEY_PATTERN과 정합(대문자 시작, 영대문자/숫자/밑줄). */
export const SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/

/** Anthropic 호환 tool 정의 — llm-wrapper가 options.tools로 머지해 LLM에 노출. */
export const REQUEST_SECRET_TOOL = Object.freeze({
  name: 'request_secret',
  description:
    '작업 수행에 필요한 환경변수(API 키·토큰 등)가 아직 등록되지 않았을 때 사용자에게 안전하게 요청합니다. ' +
    '값은 모델에 노출되지 않고 환경변수로만 주입되며, 이후 Bash 등에서 $KEY_NAME 으로 참조합니다. ' +
    '이미 등록돼 있으면 즉시 "사용 가능" 응답을 받습니다. ' +
    '사용자에게 키 값을 채팅 메시지로 직접 붙여넣으라고 요구하지 말고, 반드시 이 도구를 사용하세요(채팅 평문 노출 방지).',
  input_schema: {
    type: 'object',
    properties: {
      key_name: {
        type: 'string',
        description: '환경변수 이름. 대문자로 시작하는 영대문자/숫자/밑줄만 허용 (예: STRIPE_API_KEY, OPENAI_API_KEY)',
      },
      reason: {
        type: 'string',
        description: '이 키가 왜 필요한지 한 줄 설명. 사용자에게 그대로 표시됩니다 (예: "결제 내역 조회에 사용").',
      },
    },
    required: ['key_name'],
  },
})

/**
 * 환경변수 키 이름 유효성 검사.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidSecretKey(name) {
  return typeof name === 'string' && SECRET_KEY_PATTERN.test(name)
}

/**
 * 예약어 — request_secret으로 등록할 수 없는 키.
 *
 * 1차 방어는 격리(secret은 본체 process.env가 아닌 세션 store→도구 자식 프로세스 env에만 주입)다.
 * 이 목록은 2차 가드로, 격리 후에도 secret이 자식 Bash env에 들어가는 표면을 막는다:
 *  - 셸 실행 흐름 변수(PATH, LD_ 계열, NODE_OPTIONS 등) → 자식 Bash 도구 하이재킹·기능 파손 방지 (openclaw DANGEROUS_HOST_ENV_VARS 차용)
 *  - 내부 인프라 시크릿/식별자(LLM_PROXY_URL/WORKSPACE_ID/AGENT_RUNNER_TOKEN) → 자식 노출·우회 방지
 *  - OAuth 관리명(SLACK_TOKEN/NOTION_TOKEN) → harness-bundler가 관리하므로 충돌 방지(조용한 skip 대신 명시 거부)
 */
export const RESERVED_SECRET_KEYS = Object.freeze(new Set([
  // 셸 실행 흐름 (LD_*/DYLD_*는 RESERVED_PREFIXES로 커버)
  'PATH', 'HOME', 'SHELL', 'IFS', 'ENV', 'BASH_ENV', 'GCONV_PATH', 'SSLKEYLOGFILE',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_ENV', 'PYTHONPATH', 'PYTHONHOME', 'RUBYLIB', 'PERL5LIB',
  // daiops 인프라 시크릿/식별자
  'LLM_PROXY_URL', 'WORKSPACE_ID', 'AGENT_RUNNER_TOKEN', 'AGENT_RUNNER_PORT', 'ANTHROPIC_API_KEY',
  // OAuth 관리명 (harness-bundler가 우선 주입 — 충돌 방지)
  'SLACK_TOKEN', 'NOTION_TOKEN',
]))

/** prefix 기반 예약 — 동적 링커(LD_/DYLD_) + daiops 네임스페이스(DAIOPS_). */
const RESERVED_PREFIXES = Object.freeze(['LD_', 'DYLD_', 'DAIOPS_'])

/**
 * 예약어 여부 검사 (대소문자 무시). request_secret 등록 거부 + buildToolEnv 우회 방지에 사용.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isReservedKey(name) {
  if (typeof name !== 'string') return false
  const upper = name.toUpperCase()
  if (RESERVED_SECRET_KEYS.has(upper)) return true
  return RESERVED_PREFIXES.some((p) => upper.startsWith(p))
}
