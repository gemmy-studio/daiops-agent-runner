/**
 * cloud 내부 ingest 클라이언트 (ADR 41 Phase 3a-ii — persist 소유권 러너 이전).
 *
 * 배경: 기존엔 "러너 SSE 소비→DB write"를 cloud의 800s `ai-run` 함수가 소유해, 그 함수가 죽으면
 * terminal write 없이 메시지가 thinking에 stuck(→ reaper가 aborted로 정리, 실제 결과 유실). 러너(장기
 * 실행)가 turn 종료 시 terminal 결과를 이 짧은 멱등 ingest로 POST하면, cloud 릴레이가 죽어도 러너가
 * **실제 결과로** DB를 마감한다(QA#71 해소).
 *
 * cloud endpoint: <LLM_PROXY_URL origin>/api/internal/ingest
 * 인증: Bearer AGENT_RUNNER_TOKEN + x-workspace-id (Design B, job-keepalive/turn-manager proxy와 동일).
 * 신규 자격 없음 — 기존 러너↔cloud 내부 토큰 재사용(3b 러너 직접 Broadcast와 분리).
 *
 * fail-soft: 정상 경로(cloud 함수 생존)에선 cloud onComplete가 먼저 마감 → 이 POST는 no-op(already_finalized).
 * 실패는 비치명(다음 backstop=Track1 reaper). 로컬/테스트(env 미설정)에선 no-op.
 */

/**
 * turn 종료 terminal 결과를 cloud ingest로 1회 POST.
 * @param {{ messageId: string, seq: number, status: 'completed'|'error', content: string, errorCode?: string }} payload
 * @param {typeof globalThis.fetch} [fetchFn]
 * @returns {Promise<boolean>} POST 성공 여부(no-op/실패는 false)
 */
export async function postTerminalIngest(payload, fetchFn = globalThis.fetch) {
  const proxyUrl = process.env.LLM_PROXY_URL
  const token = process.env.AGENT_RUNNER_TOKEN
  const workspaceId = process.env.WORKSPACE_ID
  if (!proxyUrl || !token || !workspaceId) return false
  if (!payload || typeof payload.messageId !== 'string' || payload.messageId.length === 0) return false

  let url
  try {
    url = new URL('/api/internal/ingest', new URL(proxyUrl).origin).toString()
  } catch {
    return false
  }

  const body = JSON.stringify({
    messageId: payload.messageId,
    seq: typeof payload.seq === 'number' && payload.seq >= 0 ? payload.seq : 0,
    status: payload.status === 'error' ? 'error' : 'completed',
    terminal: true,
    content: typeof payload.content === 'string' ? payload.content : '',
    ...(payload.errorCode ? { errorCode: String(payload.errorCode) } : {}),
  })

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        'x-workspace-id': workspaceId,
      },
      body,
    })
    return res.ok
  } catch {
    return false // 비치명 — Track1 reaper가 2차 backstop
  }
}
