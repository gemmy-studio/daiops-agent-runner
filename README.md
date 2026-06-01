# daiops-agent-runner

daiops 샌드박스 안에서 실행되는 경량 HTTP 서버. Anthropic Messages API를 직접 호출하고 SSE로 스트리밍하며, 결재(approval) 흐름과 resume(from_seq)을 지원한다.

순수 JS (ESM) · **Node.js 22+** (`fs.glob` 의존) · 외부 의존성 0개.
메인 daiops sandbox는 `node:22-slim` 베이스를 사용하므로 동일 버전.

## 무엇인가

daiops는 직원별 샌드박스(Daytona)에서 agent loop을 돌린다. agent-runner는 그 샌드박스 안에 떠 있는 작은 HTTP 서버로, daiops 메인 앱이 HTTP로 호출하면 LLM 호출·도구 사용·결재·재개를 처리한다.

- 메인 앱(daiops) ↔ agent-runner 사이는 **HTTP만** 사용. agent-runner는 daiops 코드를 import하지 않는다.
- 메인 앱이 docker image로 sandbox에 배포 → `node server.js`로 기동.

## 빠른 실행

```bash
npm install        # dependencies 0개라 즉시 끝남
npm test           # node --test (외부 의존 없음, 276 tests)
node server.js     # 환경변수 필요 — LOCAL_DEV.md 참조
```

로컬 dev: [LOCAL_DEV.md](./LOCAL_DEV.md)

## HTTP API

| Method | Path | 인증 | 용도 |
|---|---|---|---|
| GET | `/health` | 없음 | version·schemaVersion·timestamp |
| POST | `/v1/chat` | Bearer | turn-manager 멀티턴 루프 + SSE |
| POST | `/v1/approval/{id}` | Bearer | 결재 결과 주입 (in-flight pause 해제) |

자세한 contract: [CONTRACT.md](./CONTRACT.md)

## Docker

```bash
docker build -t daiops-agent-runner .
docker run --rm -p 8430:8430 \
  -e AGENT_RUNNER_TOKEN=dev \
  -e LLM_PROXY_URL=https://daiops.example.com/api/internal/llm/messages \
  -e WORKSPACE_ID=ws-local \
  daiops-agent-runner
```

GHCR image: `ghcr.io/gemmy-studio/daiops-agent-runner:<tag>`

## License

[Apache License 2.0](./LICENSE) — Copyright 2026 Gemmy Studio Inc.

샌드박스에서 실행되는 코드라 감사 가능성을 위해 공개한다. `daiops`/`DAIOps`
상표는 라이선스와 분리 보호됨 ([NOTICE](./NOTICE) 참조).
