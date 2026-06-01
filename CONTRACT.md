# agent-runner ↔ daiops 메인 앱 contract

> agent-runner는 daiops 메인 앱 소스를 import하지 않는 **별도 npm 패키지(의존성 0)**다.
> 그래서 두 코드베이스 사이에 *수동으로 동기해야 하는* 상수와 API 형식이 존재한다.
> 이 파일이 그 contract의 단일 소스다. agent-runner를 별도 repo로 분리한 뒤에도 동일하게 유지된다.

## 1. 수동 동기 상수 (drift 시 정의 안 됨 → 런타임 오류로 검출되지 않음)

### 1-1. 샌드박스 작업 디렉토리

| agent-runner | daiops 메인 앱 | 값 |
|---|---|---|
| `handler.js:15` `DEFAULT_CWD` | `src/lib/constants.ts` `SANDBOX_PATHS.BASE` | `/workspace` |

agent-runner의 `cwd: params.context_dir ?? DEFAULT_CWD`로 들어가며, sandbox 안 모든 도구가 이 경로 기준으로 동작한다. 메인 앱이 `SANDBOX_PATHS.BASE`를 바꾸면 agent-runner도 같이 갱신해야 한다.

### 1-2. LLM fallback 모델

| agent-runner | daiops 메인 앱 | 값 |
|---|---|---|
| `handler.js:22` `DEFAULT_FALLBACK_MODEL` | `src/lib/llm/models.ts` `MODEL_REGISTRY.sonnet.id` | `claude-sonnet-4-6` |

cloud가 `params.model`을 안 보낸 경우의 fallback. 모델 세대 교체 시 두 곳을 같이 바꿔야 한다.

## 2. HTTP API contract

agent-runner가 노출하는 3개 endpoint. 메인 앱은 이 형식에만 의존한다.

### 2-1. `GET /health` (인증 불필요)

응답:
```json
{
  "status": "ok",
  "version": "0.2.0",
  "schemaVersion": 1,
  "timestamp": 1717000000000
}
```

- `version`: `package.json#version`. semver. agent-runner 자체 버전.
- `schemaVersion`: 본 contract(특히 §2) HTTP API의 버전. **integer, 본 contract가 깨지는 변경 시에만 증가**. agent-runner version과 별개.
- `timestamp`: `Date.now()`. 디버깅용.

### 2-2. `POST /v1/chat` (Bearer auth)

Request body 핵심 필드:
- `prompt`: string (필수)
- `model`: string (옵션 — 미전달 시 `DEFAULT_FALLBACK_MODEL`)
- `systemPrompt`, `history`, `context_dir`: 옵션
- `resume_session_id`, `from_seq`: resume 모드

Response: SSE stream. event 종류는 `event-buffer.js` / cloud `sdk-event-mapper.ts` 참조.

### 2-3. `POST /v1/approval/{id}` (Bearer auth)

Request:
```json
{ "decision": "allow_once" | "allow_always" | "deny",
  "allowlist_entry": "string?",
  "feedback": "string?",
  "resolved_by": "string?" }
```

Response: `{ ok: true, approval_id }` (200) | `{ error, approval_id }` (409 — 이미 resolved).

## 3. 환경변수 contract

agent-runner 시작 시 메인 앱(deployer)이 주입해야 하는 env:

| 변수 | 필수 | 용도 |
|---|---|---|
| `AGENT_RUNNER_TOKEN` | yes | Bearer auth |
| `AGENT_RUNNER_PORT` | yes | listen port (기본 8430) |
| `LLM_PROXY_URL` | yes | cloud LLM proxy |
| `WORKSPACE_ID` | yes | x-workspace-id 헤더 |
| `BASH_ENV` | no | Bash 도구 자동 source (사용자 secrets) |
| `AGENT_RUNNER_HOST` | no | bind host (기본 0.0.0.0) |

## 4. schemaVersion 증가 규칙

`schemaVersion`은 §2 HTTP API contract의 호환성 버전이다. 아래에 해당하면 +1:

- endpoint 추가/제거
- request/response 필드 제거 또는 의미 변경
- SSE event 종류 추가/제거 (cloud sdk-event-mapper 측 변경 동반)
- 인증 방식 변경

호환 변경(필드 추가 등)은 schemaVersion 유지. 메인 앱은 deploy 직후 `/health` 호출로 `schemaVersion` 일치를 검증하고, mismatch 시 명시 에러로 분기한다.
