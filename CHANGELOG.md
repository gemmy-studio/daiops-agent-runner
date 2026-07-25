# Changelog

`daiops-agent-runner`의 버전별 변경 이력. 형식은 [Keep a Changelog](https://keepachangelog.com/) 준용, 버전은 [SemVer](https://semver.org/).

## [0.9.8] — 2026-07-26

### Added
- **egress 목적지 호스트 관측기 — 도메인 allowlist 전환의 1단계 (daiops ADR42)** — 이 프록시는 이미 샌드박스의 **모든 아웃바운드**(bash curl·python·MCP)를 통과시키고 요청마다 목적지 호스트를 계산하지만, 검사는 **시크릿 placeholder가 실린 요청에만** 한다. 그래서 "어디에서 무엇을 받아오는가"는 cloud의 **명령어 문자열 정규식**(`git clone`·`npm install`…)이 대신 판단하고 있고, 목록에 없는 도구(`gh repo clone`·`svn`·`composer`·`bundle`·`mvn`·`nix-env`·`deno add`·`aria2c`)는 그대로 통과한다. 레퍼런스(Claude Code `allowedDomains` + 프록시 403 · vellum CES egress mode · 업계 사례)는 예외 없이 **목적지 도메인 allowlist**로 수렴한다 — 명령어 글자를 검사하는 곳은 없다.
  - 전환하려면 "무엇을 허용할지"를 알아야 하는데, 추측으로 목록을 만들면 정상 작업이 반드시 막힌다(npm이 registry 외 CDN을 치는 등). 그래서 **이 릴리스는 아무것도 차단하지 않는다.** 관측만 한다.
  - `EgressObserver`(`proxy/egress-observer.js`): 메모리 Map에 호스트별 요청 수를 누적하고 60초마다 변경분만 cloud `POST /api/internal/egress-observations`로 보고한다. 요청마다 보내지 않는 이유 — `npm install` 한 번이 수백 요청이라 보고가 관측 대상보다 시끄러워진다.
  - 보고 실패는 **카운트를 되돌려** 다음 주기에 합쳐 재시도한다(유실보다 누적 정확성 우선). 보고 설정이 없으면(로컬 dev) 집계만 하고 폐기해 무한 누적을 막는다.
  - 상한: 호스트 종류 2000개(메모리 무한 증가 방지) · 보고당 200개(요청 많은 순).
  - 수집 지점은 `injection-proxy.js` `_forward()`에서 `dest`가 이미 계산된 자리 한 줄(`observer.record()`). 동기 O(1)이라 hot path에 영향 없고, 관측기 미주입 시 그대로 동작한다(하위호환).
  - **★호스트와 건수만 넘긴다.** 경로·쿼리·헤더·바디는 관측기에 전달하지 않는다 — 토큰·PII가 섞일 수 있고 allowlist 판단에는 호스트만 필요하다(cloud 라우트도 호스트 정규식으로 이중 검증해 URL이 오면 400).
  - `blocked` 카운트로 기존 시크릿 호스트 방어(403)가 실제로 발동한 횟수도 함께 관측된다.
  - `server.js`가 프록시와 생애를 공유해 부팅 시 `start()`, graceful shutdown에서 마지막 `flush()`(샌드박스가 자주 꺼지므로 종료 flush가 유실을 줄인다).
  - schemaVersion 불변(§2 계약 무변경 — cloud로 나가는 아웃바운드 보고이고 이 서버의 API 표면은 그대로).

### Internal
- **도구 이름 게이트를 parity 스냅샷에 편입 (스냅샷 v2)** — v1은 Bash 정규식만 담았고, `DESTRUCTIVE_TOOL_NAMES`·`ROUTINE_WRITE_TOOL_NAMES`는 주석("cloud `policy.ts`와 동기화 유지")으로만 cloud와 묶여 있었다. cloud만 규칙을 바꾸고 이쪽을 빠뜨리면 아무 테스트도 깨지지 않는다 — 공급망 게이트가 cloud에만 추가됐던 사고(0.9.7 §Fixed)와 같은 구조다. `SANDBOX_GATE_TOOL_SETS`를 export해 `policy-sandbox-gate.json` `toolGates`와 대조한다. **규칙 변경이 아니라 감지 장치 추가**라 `minRunnerVersion`(0.9.7)은 그대로 둔다.
  - `OUTWARD_SEND_TOOL_SUFFIXES`는 제외 — 이미 폐지된 `slack_upload_file`이 이쪽에만 남아 있어(존재하지 않는 도구라 기능 차이 없음) cloud와 목록이 다르다. 그 이름을 지우는 릴리스에서 함께 스냅샷에 추가한다.

## [0.9.7] — 2026-07-25

### Fixed
- **공급망 반입 명령(`git clone`·`npm/pip install` 등)이 결재 없이 통과하던 우회로 차단 (daiops QA #31)** — `isSandboxSafeCommand`가 네트워크 여부를 `NETWORK_EGRESS_RE`(curl/wget/ssh 등 직접 유출 도구)로만 판정해, 원격에서 코드·패키지를 받아오는 반입 명령이 위험 명령·egress 어느 목록에도 없어 `sandbox` 사유로 자동 허용됐다. 같은 파일을 `curl`로 받으면 결재 카드가 뜨고 `git`으로 받으면 무사통과 — 문지기가 정문만 지키고 옆문을 열어둔 상태였다. `SUPPLY_CHAIN_EGRESS_RE`를 신설해 git(clone/fetch/pull/ls-remote/remote add·set-url/submodule), node 패키지 매니저(npm·pnpm·yarn·bun·npx), python(pip·uv·poetry·pipenv·uvx), gem/cargo/go, 시스템 패키지 매니저(apt·dnf·apk 등), brew, docker pull/run을 자동 허용에서 제외한다. **네트워크를 유발하는 서브커맨드만** 매칭해 `git commit/status/add`·`npm run`·`pip list`·`cargo build` 같은 로컬 전용 명령은 그대로 통과(git은 `-C dir`·`-c k=v`·`--opt`를 건너뛰고 서브커맨드 위치를 본다). 인용문 안 문자열(`grep -r "npm install"`)은 보수적으로 결재 대상 — 놓치는 것보다 승인창이 한 번 더 뜨는 편이 안전하고, 명령 위치 파싱은 `x=1 npm install` 같은 새 우회를 만든다. schemaVersion 불변(§2 계약 무변경).
  - **왜 러너에 넣는가**: Bash 명령은 cloud가 실행 전에 볼 수 없다(샌드박스 안 `canUseTool`이 유일한 집행 지점). 2026-07-14에 cloud `policy.ts`에만 같은 규칙을 추가하고 여기를 빠뜨려, 커밋·테스트·리뷰를 모두 통과한 채 실제로는 통과가 유지됐다.
  - **드리프트 감지 장치**: 규칙 누락을 주석(`SYNC: ...`)이 아니라 테스트로 잡는다. `policy-sandbox-gate.json` 스냅샷을 cloud와 동일 사본으로 두고, 양쪽이 각자 자기 코드와의 `.source` 일치를 단정한다. 여기에 `minRunnerVersion`을 걸어 cloud 쪽 테스트가 `AGENT_RUNNER_IMAGE` 핀 ≥ `minRunnerVersion`을 요구하므로, 규칙을 올리면 핀 → 러너 릴리스 → 러너 parity 테스트로 사슬이 닫힌다.

### Added
- **루틴 쓰기(반복 업무 CRUD) 대화형 결재 강제 (daiops QA #64)** — `isRoutineWriteTool`(`routine_create`/`routine_update`/`routine_delete`) 분기를 `evaluatePolicy`에 추가. 대화형(결재 채널 有)은 `plan_request`로 그 자리 결재, 무인은 `allow`로 통과시켜 cloud mcp-bridge가 결재 큐(`pending_write_actions`)에 적재한다(파괴적 도구의 headless=deny와 **반대**). cloud 정책에는 규칙이 있었으나 러너가 정책 config만 받고 해석 코드는 이미지에 baked돼, 채팅에서 반복 업무 수정·삭제가 승인 카드 없이 즉시 실행됐다.

## [0.8.0] — 2026-07-19

### Added
- **MCP SSRF 가드에 loopback opt-in 예외(`spec.allowLoopback`) — 샌드박스 로컬 MCP 서버 도달 허용 (daiops ADR34)** — `assertSafeMcpUrl`이 모든 loopback(`127.0.0.0/8`·`localhost`·`::1`)을 무조건 차단해, 샌드박스 안 로컬 MCP 서버(`http://127.0.0.1:8790`, knowledge-core `serve` — wiki fact 3형제)에 러너가 붙지 못했다(ADR34 로컬화 설계가 이 가드와 충돌). 이제 `McpServerSpec.allowLoopback === true`인 spec에 한해 loopback URL을 예외 허용한다. **opt-in은 신뢰된 호출자(cloud)가 자기 로컬 서버 spec에만 설정**하며, 메타데이터/내부 엔드포인트(IMDS `169.254.*`, `*.internal`, `0.0.0.0`, `::`)는 `allowLoopback`과 무관하게 **항상 차단**돼 SSRF 방어선은 유지된다. 에러 메시지도 `loopback not allowed` / `metadata/internal not allowed`로 분리. schemaVersion 불변(§2 계약 무변경).

## [0.7.9] — 2026-07-17

### Removed
- **성공/실패 무관 반복 도구 하드 중단(`REPEATED_TOOL_THRESHOLD=10`) 제거 (ADR38 Phase 3)** — 같은 도구·같은 입력을 연속 10회 호출하면 성공/실패와 무관하게 `abortController.abort()`로 루프를 하드 종료(`repeated_tool_loop` 에러)하던 옛 가드를 제거했다. 상태 폴링·같은 파일 반복 읽기처럼 **매번 성공하며 진전하는** 정상 워크플로우를 루프로 오판해 중단하던 문제였다. 반복 루프 판단은 실패 기반 `RepeatFailureGuard`(0.7 이전 도입: 같은 `(도구,입력)` 실패 3회 또는 성공 없는 연속 실패 6회 시 해당 호출만 deny)로 일원화한다. 성공만 반복하는 무해한 경우는 진전으로 보고 통과시키되, 전체 폭주는 turn budget(`max_turns` 기본 50)이 백스톱으로 잡는다. schemaVersion 불변(§2 계약 무변경).

## [0.7.6] — 2026-07-12

### Changed
- **offload per-turn 예산을 모델 컨텍스트 window에 정합 (A4)** — 기존 `TURN_RESULT_BUDGET_CHARS`는 200K **chars** 고정이라 실제 200K **토큰** window와 단위가 어긋났다(≈50K 토큰). `getAnthropicContextWindow(model)`(표준 200K, `[1m]`/`-1m` 마커→1M) + `resolveOffloadBudgetChars`(env override 절대값 우선, 없으면 window×0.3×CHARS_PER_TOKEN)로 산출해 `enforceTurnResultBudget(budgetChars)`에 전달한다. 200K window=240K chars(≈기존), 1M window=1.2M chars — 큰 window 모델에서 도구 결과를 불필요하게 오프로드하던 것을 해소. env `AGENT_RUNNER_OFFLOAD_WINDOW_FRACTION`(기본 0.3) override. (openclaw `calculateMaxToolResultChars` window×0.3 차용)

### Added
- **컨텍스트 관리 발동 사용자 고지 (A3)** — 대용량 tool_result 오프로드/오래된 결과 프루닝이 그동안 완전 무성(silent)이라 "자료 일부가 왜 요약됐는지" 사용자가 알 수 없었다. `handler.js` 콜백에 `onOffload`/`onPrune`을 배선해 `context_managed` SSE(`{kind:'offload'|'prune', offloaded/freed_chars/pruned}`)를 발신한다(cloud가 diagnostic으로 노출). llm-wrapper·turn-manager는 이미 콜백을 호출했고 handler가 전달만 누락했던 갭.

## [0.5.16] — 2026-07-05

### Fixed
- **구조화 출력 스키마 검증기가 `$ref`/`allOf`/`oneOf`를 무시하던 갭 (AGENT-API-2)** — 자체 JSON Schema 검증기(`tools/validate-schema.js`)가 `$ref`/`$defs`/`definitions`/`allOf`/`oneOf`를 인식하지 못해 무시(=통과)했다. zod-to-json-schema·pydantic 등 codegen 스키마는 대부분 `$ref`로 하위 타입을 참조하므로, 그런 `response_schema`에선 어떤 값이든 통과되고 재시도 메커니즘까지 무력화됐다(Anthropic은 forced tool_use input을 하드 검증하지 않아 이 검증기가 유일한 게이트). 이제 `$ref`는 root의 `$defs`/`definitions`를 JSON 포인터로 해석해 재귀하고(해석 불가·자기참조 사이클은 `MAX_VALIDATION_DEPTH`로 방어, false negative 방지 위해 통과), `allOf`(모두 통과)/`oneOf`(정확히 하나)를 지원한다. 의존성 0 유지. schemaVersion 불변(§2 계약 무변경). cloud는 비-object 루트 `response_schema`를 진입에서 거부(daiops #23)해 짝을 이룬다.

### Changed
- **구조화 출력을 "최종턴만 강제"로 확장 (AGENT-API-5)** — 기존(0.5.14)에는 `response_schema` 지정 시 `submit_structured_response`를 turn 0부터 `tool_choice`로 강제해, 도구를 먼저 쓴 뒤 구조화하는 워크플로우(검색→종합 등)가 불가능했고(단발 변환만) thinking도 turn 0부터 꺼졌다. 이제 `structuredMode`(기본 `final_turn`)에서 open phase 동안 도구를 자유롭게 사용하고(thinking 활성) 모델이 자연 종료(`end_turn`)하면 그때 1회만 `tool_choice`를 강제해 스키마 제출을 받는다. `immediate` 모드는 turn 0부터 강제(단발 변환 하위호환). 검증 실패 재시도 캡(3)·thinking+forced tool_choice 400 회피(forcing turn만 thinking off)는 유지.

### Added
- **typed `structured_output` SSE 이벤트** — 검증 통과한 최종 payload를 원시 JSON을 `text`로 흘리지 않고 전용 `structured_output` 이벤트로 발신한다(cloud sse-relay가 공개 `structured` 이벤트로 매핑). `done.content`에는 순수 JSON을 유지해 sync 트리거의 `structured_result` 하위호환을 보존.

## [0.5.8] — 2026-06-09

### Added
- **dist tarball Release asset 게시** — 태그(`vX.Y.Z`) push 시 런타임 JS만(테스트·문서 제외, 0-dep이라 ~84KB) 담은 `agent-runner-dist.tar.gz` + `.sha256`을 GitHub Release asset으로 게시하는 CI `release` 잡 추가. cloud(ADR 20)의 in-place 업그레이드가 이 asset을 무인증 fetch→sha256 검증→기존 워크스페이스의 `/opt/agent-runner`를 무손실 교체한다. 런타임 코드 변경 없음(0.5.7과 동일) — 버전 범프는 기존 워크스페이스가 staleness를 감지해 새 dist를 받게 하는 롤아웃 트리거.

## [0.5.7] — 2026-06-09

### Fixed
- **스트림 stale 감지·자동 재시도** — 업스트림(Anthropic / cloud LLM proxy)이 연결은 유지한 채 토큰 전송을 멈추면(mid-stream stall), agent-runner에 시간 기반 abort가 없어 cloud `FETCH_TIMEOUT`(750초)까지 매달려 사용자에게 "멈춤"으로 보이던 갭 해소. `turn-manager`의 SSE 소비를 `streamWithStaleGuard`로 감싸 chunk 간 idle이 `STREAM_STALE_TIMEOUT_MS`(기본 120초, env `AGENT_RUNNER_STREAM_STALE_MS`로 override)를 넘으면 요청 전용 AbortController로 연결을 끊고 retryable timeout(`ETIMEDOUT`)을 throw → 기존 재시도(turn 0 first-yield retry / turn 1+ `withJitteredRetry`)가 같은 turn을 자동 재시도하며 `retry` SSE로 가시화. SSE 계약(schemaVersion) 불변 — cloud 무변경 호환. (hermes `run_agent.py` stale-stream 감시 패턴 이식)
- **402 usage-limit/billing 구분** — `classifyLlmError`가 402를 전부 billing(fatal)로 처리해, 월 사용량 한도 일시 초과에도 대화가 끊기던 갭 해소. "usage limit … try again/resets" 신호가 함께 있으면 `rate_limit`(retryable)로 분류해 자동 재시도, 크레딧 소진은 그대로 billing(fatal). cloud `error-classifier.ts`(hermes `_classify_402`)와 동일 분류 — 드리프트 금지.

## [0.5.3] — 2026-06-06

### Security
- 버전 접미 인터프리터(`python3.11`·`node20`·`php8.2` 등) 위험탐지·sticky allowlist 우회 차단. `INTERPRETER_BINS` 정확집합에 없는 버전 접미 이름이 `isDangerousCommand`·`isSafeAllowlistPattern`을 모두 통과하던 갭을 `INTERPRETER_PREFIXES` 접두 매칭(`isInterpreterBin`) + `DANGEROUS_COMMAND_PATTERNS`의 `python[\d.]*` 확장으로 해소.

> 변경 이력 갭: 0.4.0~0.5.2는 CHANGELOG 미기재(git 태그·커밋 이력 참조).

## [0.3.1] — 2026-06-02

### Added
- Claude Opus 4.8(`claude-opus-4-8`) 모델 매트릭스 등재 — 출력 한도 128k, adaptive thinking·xhigh effort·sampling-param 거부 세대 substring에 `4-8`/`4.8` 추가. 미등재 시 opus-4-8 호출이 thinking 미활성 + sampling param 전송으로 400 거부될 수 있어 보강.

## [0.3.0] — 2026-06-01

> ⚠️ 이 버전은 cloud(메인 앱)와 **조율 배포**가 필요하다. 세션 프로토콜 주입 책임이 cloud로 이동해, 구버전 cloud + 본 버전 runner 조합은 세션 프로토콜이 누락된다.

### Changed
- **세션 프로토콜을 호출자(cloud)가 소유**하도록 이전 — runner는 받은 `system_prompt`를 그대로 사용하는 순수 HTTP 실행 글루로 단순화. 워크스페이스 KB/페르소나/연속성 규약은 더 이상 runner에 하드코딩하지 않는다.
- `CONTINUATION_NOTICE`를 도메인 비종속 범용 텍스트로 재작성 (멀티턴 대화 프레이밍만 담당)

### Security
- 인증 토큰 비교를 상수 시간(`timingSafeEqual`)으로 — 타이밍 사이드채널 차단
- `/v1/chat`·`/v1/approval` 에러 응답에서 내부 상세 비노출 (서버 로그로만 기록)
- MCP 서버 URL SSRF 가드 — 비 http/https 스킴·클라우드 메타데이터(IMDS)·loopback 거부
- Grep 패턴 길이 상한으로 ReDoS 완화

## [0.2.1] — 2026-05-30

### Added
- 후속 턴 재인사 방지 — `CONTINUATION_NOTICE`로 같은 세션 재진입 시 중복 인사 억제

### Changed
- 라이선스 **Apache-2.0** 명시 (LICENSE·NOTICE·package.json)
- CI Node 버전 22로 통일

### Fixed
- README License 섹션 Apache 2.0로 정정 + `package.json` `private` 복원
- 분리 repo에 부적합한 `manifest.test.js` 제거
- `handler.js` 주석 정확화 — Claude Agent SDK 미사용(Anthropic Messages API 직접 호출) 명시

## [0.2.0] — 2026-05-29

### Added
- daiops 메인 앱에서 **초기 분리** — 샌드박스 내 경량 HTTP 서버로 독립
- 순수 JS(ESM) · Node.js 22+ · **외부 의존성 0개**
- HTTP API: `GET /health`(version·schemaVersion) / `POST /v1/chat`(turn-manager 멀티턴 + SSE) / `POST /v1/approval/{id}`(in-flight pause 해제)
- 결재(approval) in-flight pause 흐름 + resume(`from_seq`) 지원
- `CONTRACT.md`(daiops↔runner HTTP 계약) + deploy 핸드셰이크 검증
- GHCR multi-stage Dockerfile 배포 (`ghcr.io/gemmy-studio/daiops-agent-runner`)

[0.3.0]: https://github.com/gemmy-studio/daiops-agent-runner/releases/tag/v0.3.0
