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

agent-runner가 노출하는 endpoint. 메인 앱은 이 형식에만 의존한다.
(`/health`, `/v1/chat`, `/v1/approval/{id}`, `/v1/secret/{id}`, `/v1/remember/{id}`, `/v1/memory/{id}`, `/v1/cancel/{sessionId}`.
secret/remember/memory는 approval과 동일한 in-flight resolve 패턴이라 상세 생략.)

**기억 도구 3종 (ADR 31)** — 저장·판정은 전부 cloud가 하고 러너는 SSE로 요청하고 결과를 기다린다.

| 도구 | SSE 이벤트 | resolve | action 어휘 |
|---|---|---|---|
`remember` (추가) | `remember_request` | `POST /v1/remember/{id}` | `saved`·`duplicate`·`failed` |
`forget` (삭제) | `memory_request` (`op:'forget'`) | `POST /v1/memory/{id}` | `removed`·`protected`·`not_found`·`failed` |
`revise` (수정) | `memory_request` (`op:'revise'`) | `POST /v1/memory/{id}` | `revised`·`protected`·`duplicate`·`not_found`·`failed` |

`forget`·`revise`는 **`/v1/chat`이 `memory_ops: ['forget','revise']`를 선언할 때만** LLM에 노출된다. 미선언이면 `remember`만 노출 — 구버전 cloud에서 도구를 노출하면 요청이 결재 타임아웃까지 매달리기 때문. action 어휘의 단일 소스는 cloud `harness/remember-instruction.ts`의 `MemoryEditAction`이다.

### 2-1. `GET /health` (인증 불필요)

응답:
```json
{
  "status": "ok",
  "version": "0.2.0",
  "schemaVersion": 2,
  "llmProxyOrigin": "https://app.example.com",
  "runtime": {
    "osCpus": 8,
    "envVcpu": 2,
    "cgroupVersion": "v2",
    "cpuMax": "200000 100000",
    "cpuMaxVcpu": 2,
    "cpuWeight": "100",
    "memoryMax": "6442450944",
    "memoryCurrent": "812345678",
    "cgroupWritable": false,
    "totalMemMb": 6144
  },
  "admission": {
    "admitted": 128,
    "waited": 3,
    "forced": 0,
    "unavailable": 0,
    "vcpu": 2,
    "memoryLimitBytes": 6442450944,
    "minFreeBytes": 644245094
  },
  "toolCgroup": {
    "enabled": false,
    "reason": "서브그룹 생성 실패: EACCES",
    "cpuWeight": null,
    "memoryHigh": null,
    "memoryMax": null,
    "attached": 0,
    "attachFailed": 0,
    "vcpu": 2,
    "group": "/sys/fs/cgroup/daiops-tools"
  },
  "timestamp": 1717000000000
}
```

- `version`: `package.json#version`. semver. agent-runner 자체 버전.
- `schemaVersion`: 본 contract(특히 §2) HTTP API의 버전. **integer, 본 contract가 깨지는 변경 시에만 증가**. agent-runner version과 별개.
- `llmProxyOrigin`: 기동 시 박힌 `LLM_PROXY_URL`의 origin. drift 감지용(§2-1 상단 참조). 미설정 시 `null`.
- `runtime`: **자원 실측 스냅샷**(부팅 1회, `runtime-probe.js`). 관측 전용이며 **필드가 늘어도 schemaVersion은 오르지 않는다** — 메인 앱은 미지의 필드를 무시해야 한다. 측정 실패 시 개별 필드는 `null`, 모듈 전체 실패 시 `runtime` 자체가 `null`.
  - `osCpus`: `os.cpus().length`. ⚠️ 컨테이너에서 **호스트 코어 수를 반환할 수 있다** — 메인 앱은 이 값을 워크스페이스 티어의 `cpu`와 비교해 불일치를 경고한다(레인 크기 파생의 정합성 검증).
  - `envVcpu`: 주입된 `AGENT_RUNNER_VCPU`(메인 앱이 티어에서 배선). 없으면 `null`.
  - `cgroupVersion`: `'v2'` / `'v1'` / `null`(미마운트).
  - `cpuMax` / `cpuMaxVcpu`: cgroup v2 `cpu.max` 원문과 그것에서 환산한 vCPU. quota가 `max`(무제한)면 `cpuMaxVcpu`는 `null`.
  - `cpuWeight` / `memoryMax` / `memoryCurrent`: cgroup v2 인터페이스 파일 원문(문자열 — 64비트 값이 `Number` 정밀도를 넘을 수 있어 파싱하지 않는다).
  - `cgroupWritable`: 서브그룹 `mkdir` + `cpu.weight` 쓰기를 **실제로 시도**해 판정(시험 후 즉시 정리). `access(W_OK)`로는 런타임 정책 차단을 알 수 없어 실측한다. 커널 집행형 자원 제한(cpu.max/memory.max) 도입 가능 여부의 판정 기준.
  - `totalMemMb`: `os.totalmem()`. `osCpus`와 같은 오보고 위험이 있어 `memoryMax`와 교차 확인용.
- `admission`: **도구 실행 admission 누적 카운터**(`tool-cpu-lane.js`). `runtime`과 달리 매 요청 최신값이다. 도구 실행 개수를 명령 이름으로 제한하던 방식을 폐지하고, spawn 직전 실제 메모리 여유로 pacing하는 구조로 바뀌었다(측정 실패 시 no-op = fail-open).
  - `admitted`: 통과한 총 횟수. `waited`: 여유 부족으로 대기한 횟수. `forced`: 대기 상한을 넘겨 여유 없이 통과시킨 횟수(**이 값이 오르면 커널 집행 계층 점검 신호**). `unavailable`: 측정 불가로 no-op 통과한 횟수.
  - `vcpu`: 실제 파생된 vCPU(`AGENT_RUNNER_VCPU` → cgroup `cpu.max` → `os.cpus()` 순).
  - `memoryLimitBytes` / `minFreeBytes`: 판정에 쓰인 상한과 확보 임계값. 상한을 못 읽으면 `null`.
- `toolCgroup`: **커널 집행 계층 상태**(`tool-cgroup.js`). 도구 자식 프로세스를 별도 cgroup v2 서브그룹에 넣어 `cpu.weight`·`memory.high`·`memory.max`를 커널이 집행하게 한다. 쓰기 위임이 없는 환경에서는 비활성되고 nice + admission이 방어를 담당한다(기능 저하 없음, 보장만 약해짐).
  - `enabled`: 활성 여부. `reason`: **비활성 사유(비활성이면 항상 문자열)** — 조용한 실패를 막기 위해 반드시 실린다. 활성이면 `null`.
  - `cpuWeight`: 도구 그룹의 `cpu.weight`(기본 20 — 루트 기본 100 대비 약 1/5 몫). 이 값 쓰기가 실패하면 부분 적용 상태로 두지 않고 전체를 비활성한다.
  - `memoryHigh` / `memoryMax`: 상한의 60% / 80%. `high`는 **소프트**(초과 시 회수 압력으로 감속, 죽이지 않음), `max`는 **하드**(초과 시 이 그룹 내에서 OOM kill → 희생자가 도구 자식으로 한정되고 러너 본체는 보호된다). 컨테이너 상한을 모르면 둘 다 `null`이고 CPU 가중치만 적용된다.
  - `attached` / `attachFailed`: 편입 성공·실패 누적. 짧은 명령이 편입 전에 종료(ESRCH)하는 것은 정상이므로 `attachFailed`가 오르는 것 자체는 이상이 아니다.
- `timestamp`: `Date.now()`. 디버깅용.

### 2-2. `POST /v1/chat` (Bearer auth)

Request body 핵심 필드:
- `prompt`: string (필수)
- `model`: string (옵션 — 미전달 시 `DEFAULT_FALLBACK_MODEL`)
- `systemPrompt`, `history`, `context_dir`: 옵션
- `thinking`: `{ effort: 'low'|'medium'|'high'|'xhigh'|'max' }` (옵션 — 미전달 시 `medium`).
  adaptive thinking 깊이. **cloud가 켜고 끄는 손잡이**라 러너는 문자열만 통과시키고 유효성 판정은
  `buildThinkingOptions`의 `ADAPTIVE_EFFORT_MAP` 한 곳에서만 한다(미지의 값 → `medium`). 목록을
  양쪽에 두면 cloud가 새 칸을 쓸 때마다 러너 재배포가 필요해진다. `xhigh`는 4.7+ 세대만 수용하고
  그 외에서는 `max`로 다운그레이드된다.
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

### 2-4. `POST /v1/cancel/{sessionId}` (Bearer auth)

진행 중 세션을 즉시 취소한다. body 없음. 처리 순서: pending approval을 deny로 강제 해소 →
`abortController.abort()` → 'aborted' SSE(EventBuffer 누적, resume replay 가능) → SDK 루프가
다음 스텝의 abort break로 종료 후 자연스럽게 'done' emit.

Response: `{ ok: true, session_id }` (200) | `{ error, session_id }` (404 — 세션이 이미 종료돼
activeSessions에 없음 = "취소할 것 없음", cloud는 성공으로 관대 처리) | `{ error }` (400 — sessionId 누락).
멱등: 이미 종료된 세션 재취소는 404.

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
| `DAIOPS_SANDBOX_WRITE_FREE` | no | 샌드박스 격리 신뢰 (ADR 21 §2.4). 기본 on — 자기 cwd 하위 Write/Edit·비-네트워크 Bash를 결재 없이 허용. 로컬 호스트 등 격리가 아닌 배포에서 파일작업까지 게이트하려면 `false`. |

## 4. schemaVersion 증가 규칙

`schemaVersion`은 §2 HTTP API contract의 호환성 버전이다. 아래에 해당하면 +1:

- endpoint 추가/제거
- request/response 필드 제거 또는 의미 변경
- SSE event 종류 추가/제거 (cloud sdk-event-mapper 측 변경 동반)
- 인증 방식 변경

호환 변경(필드 추가 등)은 schemaVersion 유지. 메인 앱은 deploy 직후 `/health` 호출로 `schemaVersion` 일치를 검증하고, mismatch 시 명시 에러로 분기한다.
