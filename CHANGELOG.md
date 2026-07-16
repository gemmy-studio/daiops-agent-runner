# Changelog

`daiops-agent-runner`의 버전별 변경 이력. 형식은 [Keep a Changelog](https://keepachangelog.com/) 준용, 버전은 [SemVer](https://semver.org/).

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
