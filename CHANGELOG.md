# Changelog

`daiops-agent-runner`의 버전별 변경 이력. 형식은 [Keep a Changelog](https://keepachangelog.com/) 준용, 버전은 [SemVer](https://semver.org/).

## [0.17.0] — 2026-08-02

> ⚠️ 0.13.0~0.16.0 항목이 이 파일에 없다 — 그 릴리스들이 CHANGELOG를 건너뛴 기존 부채이고,
> 이번 항목이 그 구멍을 메우지는 않는다. 해당 구간은 git 태그와 커밋 이력을 봐야 한다.

### Added
- **`/v1/chat`의 `thinking.effort` 수용 — cloud가 adaptive thinking 깊이를 지정할 수 있게**
  (daiops ADR 45 §3.18).
  - 배경: `buildThinkingOptions`는 이미 effort를 받는데 **cloud에서 그 값을 실어 보낼 경로가 없어서**
    전량 기본값 `medium`으로만 돌았다. daiops 실측에서 잡 실행 130초 중 도구 실행은 2초뿐이고
    128초(98.5%)가 LLM 왕복이며, 출력 토큰을 한 겹 더 쪼개면 분류성 스킬은 4,760토큰 중 가시 텍스트
    770자 + 도구 인자 668자뿐이라 **나머지 70%가 thinking**이다. effort가 그 위에 그대로 얹힌다.
  - `parseThinkingParam(raw)` — `{ effort: string }`만 통과시킨다. **미지정이면 `undefined`를
    돌려주는 것이 계약이다**: `buildThinkingOptions`가 `undefined`를 `medium`으로 해석하므로 이 필드를
    보내지 않는 구버전 cloud와 동작이 완전히 같아진다(하위호환).
  - **허용 목록을 복제하지 않는다.** 유효성 판정은 `ADAPTIVE_EFFORT_MAP` 한 곳에서만 하고 미지의 값은
    `medium`으로 떨어진다. 러너가 목록을 따로 들면 cloud가 새 칸을 쓸 때마다 러너 재배포가 필요해진다.
  - 테스트: 강제 `tool_choice`가 있으면 effort를 줘도 thinking을 싣지 않는지 단정한다 — Anthropic이
    둘의 공존을 400으로 거부하므로 이 분기가 깨지면 구조화 출력 경로가 전부 죽는다.

### Changed
- `CONTRACT.md` §2-2에 `thinking` 필드 기재. **`schemaVersion`은 2 유지** — §4가 "호환 변경(필드
  추가 등)은 schemaVersion 유지"로 규정한다(request 필드 추가이고 의미 변경이 없다).

## [0.12.0] — 2026-07-28

### Added
- **거버넌스 경로 보호 — 샌드박스 자유 쓰기의 파일 레벨 구멍 차단** (daiops ADR 21 §2.4 보완).
  - 배경: `SANDBOX_WRITE_FREE`(기본 on)가 `sandboxRoot=/workspace`를 주입해 **하위 전부**를 무결재로 열었다. 그래서 도구 레벨 결재 모델 아래에 파일 레벨 우회가 남아 있었다 — cloud가 `skill_manage`를 막아도 `Write`로 `.daiops/skills/active/…/SKILL.md`를 직접 쓰면 **사람 승인 없이 스킬이 active가 된다**(자기 승급). 사용자 지정 규칙은 더 직접적이다: daiops 프롬프트가 규칙 파일을 **DB보다 먼저** 읽으므로(`context-router/knowledge.ts`) 직원이 자기 규칙을 고치면 다음 턴에 그대로 반영되고, `[by:user]`·`[pin]` 보호가 무력화된다.
  - `PROTECTED_HARNESS_PATHS` + `isProtectedHarnessPath` — 접두사 매칭. 보호 경로는 샌드박스 예외에서 빠져 일반 게이트(등급×채널)로 넘어간다.
  - **cloud 지시 + 러너 폴백.** cloud가 `policy.protectedPaths`로 목록을 내려보내고, 미전송(구버전 cloud)이면 러너 내장 기본값을 쓴다 → 어떤 버전 조합에서도 닫힌다(fail-closed). 0.9.9 게이트 프로토콜 v2와 같은 패턴.
  - 실측: daiops active 스킬 9개는 **전부 정상 승인 기록**이 있어 우회 사례는 0건이었다. 잠재 구멍을 승인 UX가 자리잡기 전에 닫는 것.

### 의도적으로 보호하지 않는 것
- `.daiops/MEMORY.md`·`work.md` — daiops 시스템 프롬프트가 **직접 쓰라고 지시한다**("End → append a 2–3 line summary"). 막으면 정상 동작이 깨진다.
- `knowledge/`(위키) — baked CLI(=Bash)로 저장한다. `Write` 차단은 우회로를 못 막으면서 정상 업무만 깨뜨려 **보안 효과가 0**이다.

### Changed
- `policy-sandbox-gate.json` v5 — `protectedPaths` 추가, `minRunnerVersion` 0.12.0. 양쪽 parity 테스트가 코드↔스냅샷 일치를 단정한다(QA #31 재발 방지 사슬).

## [0.11.0] — 2026-07-26

### Added
- **`forget`·`revise` 도구 — 직원이 자기 영구 기억을 정리할 수 있게** (daiops ADR 31 "대체 방향"). 종전엔 `remember`(추가)만 있어 규칙이 **들어오기만** 했다. 2026-07-26 daiops 실측에서 한 워크스페이스에 114줄이 쌓여 있었고 그중 58줄이 평탄화된 작업 메모(표 번호·파일 경로), 11줄이 문장만 다른 같은 규칙이었다 — 매 대화 시스템 프롬프트에 통째로 주입되므로 쌓일수록 지시가 희석된다.
  - `tools/memory-edit.js` — `FORGET_TOOL`·`REVISE_TOOL` 정의 + `isValidRuleText`(remember와 같은 2000자 상한) + `resolveMemoryOps`.
  - `handler.js` — `onForget`·`onRevise`. `remember`와 동형으로 **cloud가 판정·수행**하고 러너는 SSE(`memory_request`)로 요청하고 결과를 기다린다. 러너는 출처·보호 지식을 갖지 않는다(0.10.0 "순수 실행기" 원칙 유지).
  - `server.js` — `POST /v1/memory/:id`(`/v1/remember/:id` 미러). action: `removed`·`revised`·`protected`·`duplicate`·`not_found`·`failed`. 실패류(`failed`·`not_found`)만 deny로 매핑하고 `protected`·`duplicate`는 "정상 처리됐고 결과가 이것"이라 allow_once다.
  - **사용자 결재를 걸지 않는다.** 30줄을 치우려면 30번 승인이 되어 자동 정리가 사실상 일어나지 않는다. 권한 바닥은 cloud의 보호 비트가 담당하고(사용자 지정 규칙은 거부), cloud가 변경 전 전문을 `agent_memory_versions`에 스냅샷해 복구 경로를 남긴다. `ApprovalManager`는 결재가 아니라 **in-flight 대기 채널로만** 쓴다.
  - `revise`를 별도 도구로 둔 이유: `forget`+`remember` 2회는 사이에 실패하면 규칙이 증발한다. 유사 규칙 여러 개를 하나로 합치는 실사용(위 11줄)이 이 연산이다.

### Changed
- **`memory_ops` 핸드셰이크 — 도구 노출권을 cloud가 소유한다.** `/v1/chat`이 `memory_ops: ['forget','revise']`를 선언할 때만 해당 도구를 LLM에 노출한다. 미선언(구버전 cloud)이면 `remember`만 노출 = **기존 동작 정확 보존**.
  - 양방향 모두 "도구가 없는" 쪽으로 안전하게 틀린다 — 구버전 러너는 필드를 무시하고, 구버전 cloud는 필드를 안 보낸다. 이 게이트가 없으면 `forget_request`를 처리 못 하는 cloud에서 LLM 호출이 결재 타임아웃(기본 10분)까지 매달린다.
  - cloud에서 배열 항목을 빼면 **러너 재배포 없이** 그 도구가 즉시 사라진다(롤백 손잡이).
- 게이트 규칙 무변경 — `policy-sandbox-gate.json` v4·`minRunnerVersion` 0.10.0 그대로. schemaVersion 불변.

> ⚠️ **cloud `AGENT_RUNNER_IMAGE` 핀은 이 이미지가 GHCR에 올라간 뒤에 올린다.** 순서: 러너 태그 push → 익명 pull 200 확인 → cloud `constants.ts` 핀을 `:0.11.0`으로(`v` 접두사 없이). 핀을 먼저 올리면 이미지 부재로 배포가 깨진다. 핀 상향 전에도 cloud는 `memory_ops`를 보내지만 0.10.1 러너가 무시하므로 안전하다(도구 미노출).

## [0.10.1] — 2026-07-26

### Fixed
- **egress 관측 보고에서 상한 초과 호스트가 조용히 사라지던 절단 제거** — `flush()`가 payload에 상위 `MAX_HOSTS_PER_REPORT`(200)개만 담으면서 집계 Map은 **전부** 비워, 201위 이하 호스트가 보고되지도 되돌려지지도 않고 소멸했다(성공 경로). 관측 1단계(0.9.8)의 목적이 "**실측으로** 도메인 allowlist 프리셋을 만드는 것"이라 **꼬리(1~2회짜리 호스트)가 오히려 중요한 데이터**인데, 하필 그 꼬리부터 사라지는 방향으로 틀려 있었다 — 프리셋을 좁게 확정해 2단계 차단에서 정상 작업이 막히는 경로다.
  - 보고 대상만 집계에서 떼어내고 초과분은 Map에 **남겨** 다음 주기에 보고한다. 보고된 호스트는 제거되므로 다음 주기엔 남은 꼬리가 상위로 올라온다(starvation 없음).
  - 실패 시 되돌리기는 종전대로 — 되돌릴 대상이 "보고를 시도한 분"으로 정확히 한정된다.
  - 테스트: 상한+3개 호스트가 두 주기에 걸쳐 **정확히 1회씩** 보고(중복·누락 0).
- 게이트 규칙 무변경 — `policy-sandbox-gate.json` v4·`minRunnerVersion` 0.10.0 그대로(관측기만 수정). schemaVersion 불변.

## [0.10.0] — 2026-07-26

### ⚠️ BREAKING
- **cloud가 `toolOverrides.v >= 2`를 보내지 않으면 `mcp__*` 도구가 결재 대상이 된다.** `minRunnerVersion` 0.10.0 — **cloud `AGENT_RUNNER_IMAGE` 핀을 함께 올려야 한다.** 정상 운영에서는 모든 cloud 실행 경로가 v2 overrides를 싣기 때문에 도달하지 않고, 구버전 cloud와 만나는 과도기에만 **과잉 결재로 안전하게 틀린다**(게이트가 사라지는 방향으로는 틀리지 않는다).

### Removed
- **도구 이름 게이트 3종 삭제 — 러너를 순수 실행기로** — `OUTWARD_SEND_TOOL_SUFFIXES`·`DESTRUCTIVE_TOOL_NAMES`·`ROUTINE_WRITE_TOOL_NAMES` + 판정 함수 3개 + `SANDBOX_GATE_TOOL_SETS` export를 제거했다. 이 사본들이 cloud와 갈라져 사고가 두 번 났고(daiops QA #31 = cloud만 수정 / QA #64 = 러너 핀 상향에만 의존), **목록이 존재하는 한 드리프트는 언제든 재발한다**. 0.9.9가 cloud 지시(v2 overrides)를 강제하게 만들었으므로 목록의 존재 이유가 사라졌다 — 이름 목록이 없으면 드리프트라는 실패 모드 자체가 없어진다.
  - **폴백은 목록 복원이 아니라 "이름을 모르는 규칙"** — cloud가 v2를 선언하지 않으면 `mcp__` 도구 전체가 결재를 요구한다.
  - `summarizeToolInput`의 발신 요약도 이름 판정 → **입력 모양**(수신자 + 본문) 판정으로 전환. 표시 로직까지 이름 의존을 끊어, 새 발신 도구가 목록 등록 없이 같은 요약을 받는다.
  - `policy-sandbox-gate.json` v4: `toolGates` 제거(0.9.8에서 편입했으나 동기화할 대상 자체가 소멸). 남은 스냅샷 대상은 **입력 패턴 게이트(정규식) + 결재 사유 키**.
- schemaVersion 불변 — §2 HTTP API 표면·인증·SSE 종류가 그대로이고, 신구 호환은 `minRunnerVersion` ↔ cloud 핀 사슬(§4 밖의 별도 장치)로 강제한다.

## [0.9.9] — 2026-07-26

### Added
- **게이트 프로토콜 v2 — cloud 지시를 강제하고 러너 하드코딩 판정을 폴백으로 강등** — 도구 게이트 판정이 cloud·러너 양쪽에 사본으로 존재해 한쪽만 고치는 사고가 반복됐다(QA #31·#64). parity 스냅샷(0.9.8)은 **사후 감지일 뿐 원인 제거가 아니다.** 근본 원인은 cloud가 `deny`만 표현할 수 있어서 "결재시키자"는 정책을 러너 릴리스 없이 보낼 방법이 없었던 것.
  - `toolOverrides.askSoft` 신설: 결재 채널이 없으면 `askFallback`을 따른다. 기존 `ask`(hard)는 그대로 deny. **등급마다 무인 처리가 다르므로**(비가역=무조건 deny / 외향발신=자율설정 존중) 하나로 합치면 둘 중 하나가 반드시 회귀한다.
  - `toolOverrides.askReasons`: 도구별 결재 사유 키. 한국어 문구는 러너가 계속 소유한다.
  - `toolOverrides.v` 핸드셰이크: `v >= 2`면 cloud가 전 등급을 보냈다는 뜻이라 러너의 하드코딩 판정(외향발신·비가역·루틴)을 끈다. 미선언(구버전 cloud)이면 종전대로 — **신구 어느 조합에서도 게이트가 사라지지 않는다.**
  - `REASON_LABEL_KO`에 `routine-write-ask`·`irreversible`·`external-write` 문구 추가 — daiops P1에서 `external-write` 결재 카드의 "왜" 줄이 공란으로 나가던 것을 메운다.
  - `policy-sandbox-gate.json` v3: `askReasonKeys` 편입 — 사유 키를 늘리면서 문구를 빠뜨리면 양쪽 parity 테스트가 잡는다.

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
