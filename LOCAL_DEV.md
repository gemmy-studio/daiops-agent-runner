# 로컬 개발 가이드

agent-runner는 daiops 메인 앱 없이도 단독 실행·테스트 가능하다. 세 가지 시나리오:

- **A · 테스트만** — `npm test`. 키·네트워크 불필요.
- **B · 완전 단독** — 메인 앱 없이 서버를 띄우고 `ANTHROPIC_API_KEY`로 Anthropic을 직접 호출. 가장 빠른 개발 루프.
- **C · cloud proxy 경유** — 실제 daiops dev 인스턴스(`LLM_PROXY_URL`)를 통해 호출. 프로덕션 경로에 가장 가깝다.

### LLM 호출 경로 분기 (`turn-manager.js` `resolveUpstream`)

어느 시나리오인지는 env 조합으로 자동 결정된다:

| 조건 | 동작 |
|---|---|
| `LLM_PROXY_URL` 설정됨 | cloud proxy 경유 (시나리오 C) |
| `LLM_PROXY_URL` 없음 **+ `WORKSPACE_ID` 없음** + `NODE_ENV≠production` | **direct Anthropic** (`ANTHROPIC_API_KEY`) — 시나리오 B |
| `LLM_PROXY_URL` 없는데 `WORKSPACE_ID` 있음(또는 `NODE_ENV=production`) | **즉시 throw** (프로덕션 가드) |

> ⚠️ **단독(B)으로 띄울 때 `WORKSPACE_ID`를 설정하면 안 된다.** 프로덕션 sandbox로 오인되어 가드에 걸린다. `WORKSPACE_ID`는 cloud proxy(C)에서만 쓴다.

## 시나리오 A · 테스트만 (LLM 호출 없음)

```bash
npm test
```

- 23개 test suite · 277개 test · 외부 의존 0 (`node --test`).
- LLM API 키 불필요 · 네트워크 불필요.
- handler·turn-manager·approval-manager·event-buffer·llm-wrapper·retry-utils 등 단위 + 통합 테스트.

## 시나리오 B · 완전 단독 (메인 앱 없이 direct Anthropic)

메인 앱·sandbox 없이 agent-runner만 띄워 Anthropic을 직접 호출한다. 가장 빠른 개발 루프.

### 사전 요구

- Node.js 22+ (`fs.glob` 사용)
- `ANTHROPIC_API_KEY` (개인 키)

### 실행

```bash
npm install                              # 의존성 0개라 즉시 끝남
AGENT_RUNNER_TOKEN=dev-token \
ANTHROPIC_API_KEY=sk-ant-... \
node server.js                           # 또는 npm run dev (node --watch)
# → [agent-runner] listening on 0.0.0.0:8430
```

> `WORKSPACE_ID`·`LLM_PROXY_URL`은 **설정하지 않는다** (위 가드 표 참조). 이 둘이 없어야 direct Anthropic 경로로 흐른다.

### 동작 확인

`node server.js`는 HTTP 서버를 띄울 뿐이다 — 실제 동작은 **별도 터미널에서** `/v1/chat`을 호출해야 본다.

```bash
# 1) health (인증 불필요)
curl -s http://localhost:8430/health | jq
# → { "status": "ok", "version": "...", "schemaVersion": 1, "timestamp": ... }

# 2) chat (Bearer 필요). 요청 본문 필드는 `message` (NOT `prompt`)
curl -N -H "Authorization: Bearer dev-token" \
     -H "Content-Type: application/json" \
     -d '{"message":"안녕, 너는 누구야?","model":"claude-sonnet-4-6"}' \
     http://localhost:8430/v1/chat
```

`/v1/chat`은 SSE 스트림이라 `-N`(no buffering) 필수.

### 요청 본문 핵심 필드 (`handler.js` `handleChat`)

| 필드 | 필수 | 설명 |
|---|---|---|
| `message` | yes | 사용자 입력. **`prompt` 아님** |
| `model` | no | 미지정 시 `claude-sonnet-4-6` fallback |
| `context_dir` | no | 도구 실행 cwd. 미지정 시 `/workspace` |
| `session_id` | no | 미지정 시 자동 UUID |
| `system_prompt` / `history` / `tools` / `policy` / `max_turns` | no | 멀티턴·도구·결재 제어 |

> ⚠️ **도구(Bash/파일 등)를 쓰는 시나리오**면 cwd 기본값 `/workspace`가 로컬 PC엔 없으므로 요청에 실존 경로를 넘긴다: `"context_dir":"/tmp/agent-test"` (디렉토리 미리 생성). 순수 텍스트 채팅은 cwd와 무관.
>
> `EventBuffer`도 기본 `/workspace/.agent-runner/buffer`에 쓰므로, 로컬에선 `AGENT_RUNNER_BUFFER_DIR=/tmp/agent-runner-buffer`를 함께 주면 안전하다.

## 시나리오 C · cloud proxy 경유 (실제 daiops dev 인스턴스)

LLM 호출을 메인 앱의 proxy endpoint로 보낸다. 프로덕션 경로(키 회전·quota·감사)에 가장 가깝다.

### 환경변수

| 변수 | 필수 | 용도 | 예시 |
|---|---|---|---|
| `AGENT_RUNNER_TOKEN` | yes | Bearer auth | `dev-token` |
| `LLM_PROXY_URL` | yes | cloud LLM proxy endpoint | `https://daiops-dev.example.com/api/internal/llm/messages` |
| `WORKSPACE_ID` | yes | `x-workspace-id` 헤더 | `ws-local-dev` |
| `AGENT_RUNNER_PORT` | no | listen port | `8430` (기본) |
| `AGENT_RUNNER_HOST` | no | bind host | `0.0.0.0` (기본) |
| `BASH_ENV` | no | Bash 도구 auto-source 파일 | `/workspace/.integrations.env` |

> 로컬 메인 앱(`localhost:3000`)을 proxy로 쓰려면 daiops 워크스페이스에서 `pnpm dev:tunnel`로 ngrok을 띄우고 그 공인 URL을 `LLM_PROXY_URL`로 지정한다 (sandbox→localhost 도달 불가 때문). 자세히는 아래 "메인 앱과 함께 띄우기" 참조.

### 실행

```bash
AGENT_RUNNER_TOKEN=dev-token \
AGENT_RUNNER_PORT=8430 \
LLM_PROXY_URL=https://daiops-dev.example.com/api/internal/llm/messages \
WORKSPACE_ID=ws-local-dev \
node server.js
```

동작 확인 curl은 시나리오 B와 동일 (`message` 필드 사용).

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
