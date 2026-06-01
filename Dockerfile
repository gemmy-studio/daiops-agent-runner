FROM node:22-alpine

WORKDIR /opt/agent-runner

# dependencies 0개라 lockfile/install 불필요 — 그래도 npm ci 호환 위해 package.json만 복사
COPY package.json ./

# 소스 복사 (test·문서 제외는 .dockerignore가 처리)
COPY . .

EXPOSE 8430

# AGENT_RUNNER_TOKEN·LLM_PROXY_URL·WORKSPACE_ID는 런타임 주입
CMD ["node", "server.js"]
