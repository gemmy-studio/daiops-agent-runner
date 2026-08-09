/**
 * 도구 결과 가드 — 미신뢰 콘텐츠가 모델 컨텍스트에 들어가기 전 **한 지점**에서 처리한다.
 *
 * 순서가 중요하다:
 *   ① 가명화 (pii-pseudonymize) — 원본 번호를 토큰으로. 봉투보다 **먼저** 해야 봉투 태그가
 *      가명화 대상에 걸리지 않는다.
 *   ② 봉투 (untrusted-envelope) — 남은 본문을 nonce 델리미터로 감싼다.
 *
 * ## 무엇을 미신뢰로 보나 — 좁게 잡는다
 *
 * 전부 감싸면 경고가 배경 소음이 되어 신호가 죽는다. 대상은 **바깥에서 들어온 문서**뿐이다:
 *
 *  - `Read` 가 첨부·문서 추출 캐시를 읽을 때
 *  - `Bash` 가 문서 파서 CLI(document-core/document-hwp)를 실행했을 때
 *
 * 스킬 파일·`.claude/`·에이전트가 스스로 만든 산출물은 대상이 아니다.
 *
 * ## 적용되지 않는 경로 (알고 두는 구멍)
 *
 *  - **MCP 도구 결과** — turn-manager 가 자체 라우팅해 이 자리를 지나지 않는다.
 *  - **이미지** — Read 가 이미지 블록(배열)을 돌려주면 텍스트 처리가 불가능하다. 등기부등본이
 *    하필 이미지 판독 대상이라, 그 경로는 cloud 출력 필터가 유일한 방어다.
 *  - **에러 결과** — 감싸지 않는다(azure-devops-mcp PR #1062 와 같은 판단). 오류 문구까지
 *    울타리에 넣으면 에이전트가 실패를 데이터로 오해한다.
 */

import { pseudonymizePii } from './pii-pseudonymize.js'
import { wrapUntrusted } from './untrusted-envelope.js'

/** 미신뢰로 보는 경로 조각. 첨부와 문서 추출 캐시. */
const UNTRUSTED_PATH_HINTS = ['/.attachments/', '/.cache/', '/uploads/']

/** 문서 파서 CLI 호출 감지 — 이 명령의 stdout 은 곧 외부 문서 본문이다. */
const DOCUMENT_CLI_RE =
  /(document-core|document-hwp)[^\s]*\/cli\.js\s+(readPdf|readDocx|readXlsx|readHwp|readHwpx|readPptx|convert)/

/**
 * 이 도구 결과가 외부 문서에서 온 것인가.
 *
 * @returns {{ untrusted: boolean, source?: string, origin?: string }}
 */
export function classifyToolResult(name, input) {
  if (name === 'Read') {
    const filePath = String(input?.file_path ?? '')
    if (UNTRUSTED_PATH_HINTS.some((hint) => filePath.includes(hint))) {
      return { untrusted: true, source: 'document', origin: filePath }
    }
    return { untrusted: false }
  }
  if (name === 'Bash') {
    const command = String(input?.command ?? '')
    if (DOCUMENT_CLI_RE.test(command)) {
      return { untrusted: true, source: 'document' }
    }
    return { untrusted: false }
  }
  return { untrusted: false }
}

/**
 * 도구 결과에 가드를 적용한다. 대상이 아니면 **원본을 그대로 돌려준다**(참조 동일).
 *
 * @param {{ name: string, input: unknown, result: { content: unknown, is_error?: boolean }, registry: object, types?: string[], onCounts?: (counts: Record<string, number>) => void }} args
 */
export function guardToolResult(args) {
  const { name, input, result, registry, types, onCounts } = args
  if (!result || result.is_error) return result
  // 이미지 등 블록 배열은 텍스트 처리 대상이 아니다(위 "구멍" 참조).
  if (typeof result.content !== 'string') return result

  const verdict = classifyToolResult(name, input)
  if (!verdict.untrusted) return result

  const { text, counts } = pseudonymizePii(result.content, { registry, types })
  if (onCounts && Object.keys(counts).length > 0) {
    try {
      onCounts(counts)
    } catch {
      // 관측 신호가 도구 실행을 깨서는 안 된다.
    }
  }

  return {
    ...result,
    content: wrapUntrusted(text, { source: verdict.source, origin: verdict.origin }),
  }
}
