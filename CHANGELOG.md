# Changelog

`daiops-agent-runner`의 버전별 변경 이력. 형식은 [Keep a Changelog](https://keepachangelog.com/) 준용, 버전은 [SemVer](https://semver.org/).

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
