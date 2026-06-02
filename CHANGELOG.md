# Changelog

`daiops-agent-runner`의 버전별 변경 이력. 형식은 [Keep a Changelog](https://keepachangelog.com/) 준용, 버전은 [SemVer](https://semver.org/).

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
