# 로컬 개발 가이드

agent-runner는 daiops 메인 앱 없이도 단독 실행·테스트 가능하다. 두 가지 시나리오:

## 시나리오 A · 테스트만 (LLM 호출 없음)

```bash
npm test
```

- 23개 test suite · 277개 test · 외부 의존 0 (`node --test`).
- LLM API 키 불필요 · 네트워크 불필요.
- handler·turn-manager·approval-manager·event-buffer·llm-wrapper·retry-utils 등 단위 + 통합 테스트.

## 시나리오 B · 서버 띄우고 직접 호출

daiops cloud 없이 띄우려면 LLM proxy 역할을 mock하거나, 실제 daiops dev 인스턴스를 사용한다.

### 환경변수

| 변수 | 필수 | 용도 | 예시 |
|---|---|---|---|
| `AGENT_RUNNER_TOKEN` | yes | Bearer auth | `dev-token` |
| `AGENT_RUNNER_PORT` | no | listen port | `8430` (기본) |
| `AGENT_RUNNER_HOST` | no | bind host | `0.0.0.0` (기본) |
| `LLM_PROXY_URL` | yes | cloud LLM proxy endpoint | `https://daiops-dev.example.com/api/internal/llm/messages` |
| `WORKSPACE_ID` | yes | x-workspace-id 헤더 | `ws-local-dev` |
| `BASH_ENV` | no | Bash 도구 auto-source 파일 | `/workspace/.integrations.env` |

### 실행

```bash
AGENT_RUNNER_TOKEN=dev-token \
AGENT_RUNNER_PORT=8430 \
LLM_PROXY_URL=https://daiops-dev.example.com/api/internal/llm/messages \
WORKSPACE_ID=ws-local-dev \
node server.js
```

또는:

```bash
npm run dev    # node --watch
```

### 동작 확인

```bash
# health (인증 불필요)
curl -s http://localhost:8430/health | jq

# chat (Bearer 필요)
curl -N -H "Authorization: Bearer dev-token" \
     -H "Content-Type: application/json" \
     -d '{"prompt":"hello"}' \
     http://localhost:8430/v1/chat
```

`/v1/chat`은 SSE 스트림이라 `-N`(no buffering) 필수.

## 디버깅

- 서버 로그: stdout/stderr.
- in-flight 세션 abort: SIGINT (`Ctrl+C`) → graceful shutdown.
- 결재 흐름 테스트: `/v1/chat`이 plan_request 이벤트 발행 → 별도 터미널에서 `POST /v1/approval/{id}` 호출.

## daiops 메인 앱과 함께 띄우기

agent-runner를 메인 앱과 같이 돌리려면 daiops를 sandbox에 띄워야 한다 — 본 repo 범위 밖. daiops 워크스페이스의 `pnpm dev:tunnel`을 띄운 뒤 그 cloud URL을 `LLM_PROXY_URL`로 지정.

## 코드 구조

| 파일 | 역할 |
|---|---|
| `server.js` | HTTP 엔트리, /health·/v1/chat·/v1/approval 라우팅 |
| `handler.js` | `handleChat` — turn-manager 호출, EventBuffer 누적 |
| `turn-manager.js` | LLM 멀티턴 루프, thinking 보존, 재시도 |
| `llm-wrapper.js` | Anthropic Messages API 직접 호출 (raw fetch) |
| `approval-manager.js` | canUseTool 훅 — in-flight pause (T1) |
| `event-buffer.js` | SSE 이벤트 누적 + resume(from_seq) |
| `retry-utils.js` | jittered backoff, first-yield retry |
| `mcp-client.js` | MCP 도구 호출 (옵션) |
| `tools/` | bash·file·git 도구 정의 |

contract: [CONTRACT.md](./CONTRACT.md).
