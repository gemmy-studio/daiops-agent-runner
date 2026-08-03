#!/usr/bin/env bash
#
# agent-runner 릴리스 — 태그 push → CI(이미지 + dist tarball) → 익명 pull 검증 → cloud 핀 안내.
#
# 왜 스크립트인가: 이 릴리스는 순서가 틀리면 조용히 깨진다.
#   - 태그를 먼저 push하고 커밋을 안 하면 CI가 옛 코드를 빌드한다
#   - GHCR 패키지는 레포가 public이어도 **항상 private로 생성**된다 → Daytona 익명 pull이 401
#   - cloud 핀은 'v' 없는 태그(`:0.14.0`)다. `:v0.14.0`은 404 (CI의 {{version}}이 v를 뗀다)
#   - dist tarball은 **태그 push에서만** 생성된다(main push는 이미지만) → in-place 업그레이드 경로가 빈다
# 위 넷은 모두 실제로 겪은 사고다. 여기서 순서와 검증을 고정한다.
#
# 사용:
#   scripts/release.sh                 # package.json version으로 릴리스
#   scripts/release.sh --dry-run       # 검사만(push 안 함)
#   scripts/release.sh --version 0.14.0
#
# 참조: .github/workflows/ci.yml (test → docker → release) ·
#       ../../.claude/rules/licensing.md "신규 분리 레포 체크리스트" 7·8항
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_DIR=$(pwd)
IMAGE="ghcr.io/gemmy-studio/daiops-agent-runner"
DRY_RUN=0
VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --version) VERSION="${2:?--version 값이 필요합니다}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*" >&2; }
die()  { bad "$*"; exit 1; }

# ── 1. 프리플라이트 ──────────────────────────────────────────────
say "1) 프리플라이트"

[ -f package.json ] || die "agent-runner 레포가 아닙니다 (package.json 없음): $REPO_DIR"

PKG_VERSION=$(node -p "require('./package.json').version")
VERSION="${VERSION:-$PKG_VERSION}"
TAG="v${VERSION}"
ok "레포 $REPO_DIR"
ok "버전 $VERSION (package.json $PKG_VERSION) → 태그 $TAG → 이미지 ${IMAGE}:${VERSION}"

[ "$VERSION" = "$PKG_VERSION" ] || die "지정 버전($VERSION) ≠ package.json($PKG_VERSION). package.json을 먼저 올리세요 — CI가 이 값을 dist에 스탬프하고 cloud가 그것으로 신선도를 판정합니다."

# ⚠️ 미커밋이 있으면 **중단**한다. 태그는 커밋을 가리키므로 미커밋 변경은 릴리스에 들어가지
#    않는다 — "고쳤는데 안 나갔다"가 이 경로에서 나온다. 남의 진행 중 작업을 실수로 함께
#    커밋하는 것도 막는다(이 레포는 여러 세션이 만진다).
DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  bad "미커밋 변경이 있습니다 — 릴리스에 포함되지 않습니다:"
  printf '%s\n' "$DIRTY" | sed 's/^/      /'
  die "커밋하거나 stash한 뒤 다시 실행하세요."
fi
ok "작업 트리 깨끗"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || bad "현재 브랜치가 main이 아닙니다($BRANCH) — CI의 docker/release job은 태그에서 돌므로 진행은 가능하지만 의도한 커밋인지 확인하세요."

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  TAGGED=$(git rev-parse "refs/tags/${TAG}")
  HEAD_SHA=$(git rev-parse HEAD)
  if [ "$TAGGED" != "$HEAD_SHA" ]; then
    die "태그 ${TAG}가 이미 있고 HEAD와 다른 커밋을 가리킵니다 (tag=${TAGGED:0:8}, HEAD=${HEAD_SHA:0:8}). 버전을 올리거나 태그를 정리하세요."
  fi
  ok "태그 ${TAG} 존재 — HEAD와 동일"
  TAG_EXISTS=1
else
  ok "태그 ${TAG} 신규"
  TAG_EXISTS=0
fi

# 원격에 같은 태그가 이미 있으면 CI가 다시 돌지 않는다(= 배포된 줄 알고 넘어간다).
if git ls-remote --tags origin "refs/tags/${TAG}" | grep -q .; then
  die "원격에 태그 ${TAG}가 이미 있습니다. 이미 릴리스된 버전입니다 — package.json 버전을 올리세요."
fi
ok "원격에 ${TAG} 없음"

say "2) 테스트 (CI와 같은 명령)"
npm test
ok "npm test 통과"

# 런타임 JS 문법 — dist에 들어가는 파일만. CI의 test job이 잡지 못하는 파싱 오류 방어.
find . -maxdepth 2 -name '*.js' \
  -not -path './node_modules/*' -not -path './dist/*' -not -name '*.test.js' \
  -exec node --check {} \; >/dev/null
ok "node --check 통과(런타임 JS)"

if [ "$DRY_RUN" = "1" ]; then
  say "--dry-run — 여기서 멈춥니다. push하지 않았습니다."
  echo "  다음에 실행될 것: git push origin ${BRANCH} && git push origin ${TAG}"
  exit 0
fi

# ── 3. push ─────────────────────────────────────────────────────
say "3) push (커밋 먼저, 태그 나중)"
# 순서가 중요하다 — 태그만 먼저 가면 CI가 원격에 없는 커밋을 빌드하려다 실패한다.
git push origin "$BRANCH"
ok "커밋 push"
[ "$TAG_EXISTS" = "1" ] || git tag -a "$TAG" -m "agent-runner ${VERSION}"
git push origin "$TAG"
ok "태그 ${TAG} push → CI 시작"

# ── 4. CI 대기 ──────────────────────────────────────────────────
say "4) CI 대기 (test → docker → release)"
if command -v gh >/dev/null 2>&1; then
  sleep 5
  RUN_ID=$(gh run list --limit 20 --json databaseId,headBranch,event \
    --jq "[.[] | select(.headBranch==\"${TAG}\")] | .[0].databaseId" 2>/dev/null || echo "")
  if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ]; then
    gh run watch "$RUN_ID" --exit-status || die "CI 실패 — 이미지·tarball이 게시되지 않았습니다. cloud 핀을 올리지 마세요."
    ok "CI 성공"
  else
    bad "태그 run을 찾지 못했습니다. 수동 확인: gh run list"
  fi
else
  bad "gh CLI가 없습니다. 수동 확인: https://github.com/gemmy-studio/daiops-agent-runner/actions"
  read -r -p "  CI가 성공했으면 Enter (중단은 Ctrl-C): " _
fi

# ── 5. 익명 pull 검증 ───────────────────────────────────────────
say "5) GHCR 익명 pull 검증"
# ⚠️ **레포가 public이어도 컨테이너 패키지는 항상 private로 생성된다.** 이걸 놓치면 Daytona가
#    401로 샌드박스를 못 만든다(licensing.md 7항). 토큰 엔드포인트가 200이면 public이다.
SCOPE="repository%3Agemmy-studio%2Fdaiops-agent-runner%3Apull"
CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  "https://ghcr.io/token?scope=${SCOPE}&service=ghcr.io" || echo "000")
if [ "$CODE" = "200" ]; then
  ok "익명 pull 가능 (HTTP 200)"
else
  bad "익명 pull 불가 (HTTP ${CODE}) — 패키지가 private입니다."
  echo "      org Packages에서 daiops-agent-runner를 Public으로 전환하세요:"
  echo "      https://github.com/orgs/gemmy-studio/packages"
  echo "      (org에서 public 패키지 생성이 막혀 있으면 owner가 Settings → Packages에서 먼저 허용)"
  die "이 상태로 cloud 핀을 올리면 샌드박스 생성이 401로 실패합니다."
fi

# ── 6. cloud 핀 안내 ────────────────────────────────────────────
say "6) 남은 일 — cloud 핀 (이 스크립트가 하지 않습니다)"
cat <<EOF
  cloud는 **별 레포**라 여기서 고치지 않습니다. 아래를 직접 반영하세요.

    파일 : saas/daiops/src/lib/constants.ts
    변경 : AGENT_RUNNER_IMAGE = '${IMAGE}:${VERSION}'
           ⚠️ 'v' 없이 — CI의 {{version}}이 v를 떼고 push합니다(':v${VERSION}'은 404).
           EXPECTED_AGENT_RUNNER_VERSION은 이 핀에서 파생되므로 따로 고치지 않습니다.

  그 다음:
    1. cloud 배포(Vercel Ready 확인)
    2. 워크스페이스 퇴근 → 출근  ← fleet이 새 이미지/ dist로 갈아타는 시점
    3. 반영 확인(채팅에 붙여넣기):
         cat /opt/agent-runner/package.json | grep version 출력만 그대로 보여줘
       → ${VERSION} 이 나와야 합니다.
EOF
say "릴리스 ${VERSION} 완료 — 이미지 게시·익명 pull 확인까지."
