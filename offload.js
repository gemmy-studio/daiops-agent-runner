/**
 * per-turn tool_result 총량 예산 + 파일 오프로드 (우선순위1).
 *
 * hermes context_compressor의 enforce_turn_budget 패턴 차용. 한 turn에서 도구들이 반환한
 * tool_result 합계가 예산(chars)을 넘으면, 큰 것부터 샌드박스 파일로 빼고 그 자리엔
 * head+tail 프리뷰 + "Read로 다시 열어라" 안내만 남긴다. LLM 미호출(cheap).
 *
 * 원본은 /workspace persistent volume(Daytona sandbox)에 저장돼 sandbox restart에도 생존하며,
 * 모델이 다시 봐야 하면 Read(path)로 재로드한다(문맥 복구 경로 보존 — turn-manager 프루닝 철학과 정합).
 *
 * per-turn 오프로드(이 파일, 새 결과 폭발 방지)와 protect-tail 프루닝(turn-manager.js,
 * 누적된 오래된 결과 정리)은 상보적이다.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 오프로드 원본 저장 디렉토리. event-buffer.js와 동일하게 /workspace persistent volume 하위.
 * /tmp는 sandbox restart 시 휘발되므로 금지. AGENT_RUNNER_OFFLOAD_DIR로 override(테스트).
 */
const OFFLOAD_DIR = process.env.AGENT_RUNNER_OFFLOAD_DIR ?? '/workspace/.agent-runner/offload'

/** 한 turn tool_result 합계 상한(chars). 초과 시 큰 것부터 오프로드. hermes DEFAULT_TURN_BUDGET_CHARS 차용. */
export const TURN_RESULT_BUDGET_CHARS = (() => {
  const v = Number(process.env.AGENT_RUNNER_TURN_RESULT_BUDGET_CHARS)
  return Number.isFinite(v) && v > 0 ? v : 200_000
})()

/** 이보다 작은 개별 결과는 오프로드 대상 아님(작은 것 여러 개를 파일로 빼도 이득 없음). */
export const OFFLOAD_SINGLE_MIN_CHARS = 8_000

/**
 * **개별 MCP 도구 결과 상한(chars).** per-turn 예산(위)과 **다른 것을 막는다.**
 *
 * per-turn 예산은 *합계* 기준이라 호출 하나가 그 아래면 통과한다 — 기본 예산이
 * 200K토큰 window × 0.3 × 4 = 240,000자이므로, **단일 MCP 응답 20만 자(≈5만 토큰)가
 * 무사히 컨텍스트로 들어간다.** 외부 서버의 목록 조회는 실제로 그만큼 준다.
 *
 * 값은 openclaude `DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25_000`(× 4자/토큰 = 100,000자)를 따랐다.
 * opencode 는 더 좁다(`Truncate.MAX_BYTES = 50KB`, 모든 도구 공통). 두 레퍼런스 다 **per-call**
 * 상한을 두고 있고 daiops 만 없었다.
 *
 * 빌트인 도구에는 걸지 않는다 — Bash·Read 는 이미 자체 상한(64KB·5MB)이 있고, 그쪽은 우리가
 * 출력 형태를 통제한다. MCP 응답만 크기를 상대가 정한다.
 */
export const MCP_RESULT_MAX_CHARS = (() => {
  const v = Number(process.env.AGENT_RUNNER_MCP_MAX_RESULT_CHARS)
  return Number.isFinite(v) && v > 0 ? v : 100_000
})()

/**
 * 오프로드 파일 보관 기간(ms). 지나면 다음 오프로드 때 청소한다.
 *
 * ⚠️ 종전에는 **정리가 아예 없었다.** 저장 위치가 `/workspace`(Daytona persistent volume)라
 * 샌드박스 재시작에도 살아남아 무한히 쌓인다. per-call 상한이 생기면 오프로드 빈도가 올라가므로
 * 정리 없이 상한만 넣으면 디스크 문제를 키운다 — 둘은 함께 가야 한다.
 * (opencode `Truncate`: 7일 보관 + 시간당 cleanup 스케줄러. 러너에는 스케줄러가 없어
 *  오프로드 경로에 얹는다 — 파일이 안 생기면 청소할 것도 없으므로 그 결합이 자연스럽다.)
 */
export const OFFLOAD_RETENTION_MS = (() => {
  const v = Number(process.env.AGENT_RUNNER_OFFLOAD_RETENTION_MS)
  return Number.isFinite(v) && v > 0 ? v : 7 * 24 * 60 * 60 * 1000
})()

/** 청소 최소 간격(ms) — 매 오프로드마다 디렉토리를 훑지 않는다. */
const OFFLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** 프리뷰 head+tail 총 길이(chars). */
export const OFFLOAD_PREVIEW_CHARS = 1_500

/** 오프로드된 결과를 식별하는 마커(재오프로드 무한 방지 = 멱등). */
export const OFFLOAD_MARKER = '…[대용량 도구 결과 오프로드됨]'

/** tool_result.content(string | [{type:'text',text}])를 평문으로. turn-manager toolResultText와 동일 규칙. */
function toText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
  }
  return ''
}

/**
 * head + tail 중앙 생략 프리뷰. head 60% / tail 40%.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function truncateMiddle(text, maxChars = OFFLOAD_PREVIEW_CHARS) {
  if (typeof text !== 'string' || text.length <= maxChars) return text
  const head = Math.ceil(maxChars * 0.6)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n… [중간 ${(text.length - maxChars).toLocaleString()}자 생략] …\n${text.slice(-tail)}`
}

let offloadDirEnsured = false
async function ensureOffloadDir() {
  if (offloadDirEnsured) return
  try {
    await fs.mkdir(OFFLOAD_DIR, { recursive: true })
    offloadDirEnsured = true
  } catch (err) {
    // mkdir 실패는 fatal 아님 — writeOffload catch에서 폴백 처리.
    console.warn(`[offload] mkdir 실패 ${OFFLOAD_DIR}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 마지막 청소 시각(프로세스 로컬). 0이면 아직 안 함. */
let lastSweepAt = 0

/**
 * 보관 기간이 지난 오프로드 파일을 지운다. 실패는 전부 무시한다 — 청소는 부수적이고,
 * 여기서 던지면 정작 오프로드(문맥 보존)가 실패한다.
 *
 * 시간 기준은 파일명이 아니라 **mtime**이다. 파일명은 randomUUID라 시각 정보가 없다.
 * @returns {Promise<number>} 지운 파일 수
 */
export async function sweepOffloadDir(now = Date.now()) {
  if (now - lastSweepAt < OFFLOAD_SWEEP_INTERVAL_MS) return 0
  lastSweepAt = now
  let removed = 0
  try {
    const entries = await fs.readdir(OFFLOAD_DIR)
    for (const name of entries) {
      if (!name.startsWith('tool-result-')) continue
      const p = path.join(OFFLOAD_DIR, name)
      try {
        const st = await fs.stat(p)
        if (now - st.mtimeMs < OFFLOAD_RETENTION_MS) continue
        await fs.unlink(p)
        removed++
      } catch { /* 개별 파일 실패는 건너뛴다 */ }
    }
  } catch { /* 디렉토리 부재 등 — 청소할 것이 없다 */ }
  if (removed > 0) console.log(`[offload] 만료 파일 ${removed}개 정리`)
  return removed
}

/** 테스트 전용 — 프로세스 로컬 청소 쿨다운 초기화. */
export function _resetOffloadSweepForTest() {
  lastSweepAt = 0
}

/**
 * 원문을 오프로드 파일에 저장.
 * @param {string} text
 * @returns {Promise<string|null>} 저장 경로(절대) 또는 실패 시 null
 */
async function writeOffload(text) {
  await ensureOffloadDir()
  // 쓰기 직전에 만료분을 턴다(쿨다운 있음). 파일이 생기는 자리에 청소를 붙여야
  // "쌓이기만 하고 안 지워지는" 상태가 구조적으로 불가능해진다.
  void sweepOffloadDir()
  const p = path.join(OFFLOAD_DIR, `tool-result-${randomUUID()}.txt`)
  try {
    await fs.writeFile(p, text, 'utf-8')
    return p
  } catch (err) {
    console.warn(`[offload] write 실패 ${p}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * 한 turn의 tool_result 합계가 예산을 넘으면 큰 것부터 파일로 오프로드(in-place mutate).
 * 이미지 블록 포함 결과(base64는 char로 안 잡힘)·이미 오프로드된 것·작은 것은 건드리지 않음.
 *
 * @param {Array<{content: string | Array<unknown>, is_error?: boolean}>} toolResults
 * @param {{ onOffload?: (info: {offloaded:number, freedChars:number}) => void, budgetChars?: number }} [opts]
 *   budgetChars: 이 turn 예산(chars). 미지정 시 모듈 기본(TURN_RESULT_BUDGET_CHARS). 호출자(turn-manager)가
 *   모델 컨텍스트 window에서 산출한 값을 넘겨 200K chars 고정(≈50K토큰) 단위 불일치를 해소한다(A4).
 * @returns {Promise<number>} 오프로드한 결과 수
 */
export async function enforceTurnResultBudget(toolResults, { onOffload, budgetChars } = {}) {
  if (!Array.isArray(toolResults) || toolResults.length === 0) return 0

  const budget = Number.isFinite(budgetChars) && budgetChars > 0 ? budgetChars : TURN_RESULT_BUDGET_CHARS

  let total = 0
  const sized = []
  for (const r of toolResults) {
    const hasImage = Array.isArray(r.content) && r.content.some((c) => c && c.type === 'image')
    const text = toText(r.content)
    total += text.length
    sized.push({ r, text, len: text.length, hasImage })
  }
  if (total <= budget) return 0

  // 큰 것부터 — 최소 개수의 오프로드로 예산 아래로 내려가게(hermes: 큰 것부터).
  sized.sort((a, b) => b.len - a.len)

  let offloaded = 0
  let freedChars = 0
  for (const s of sized) {
    if (total <= budget) break
    if (s.hasImage) continue
    if (s.len < OFFLOAD_SINGLE_MIN_CHARS) continue
    if (typeof s.r.content === 'string' && s.r.content.startsWith(OFFLOAD_MARKER)) continue

    const savedPath = await writeOffload(s.text)
    const preview = truncateMiddle(s.text, OFFLOAD_PREVIEW_CHARS)
    const note = savedPath
      ? `\n\n${OFFLOAD_MARKER} 전체 ${s.len.toLocaleString()}자는 ${savedPath} 에 저장됨. 필요하면 Read("${savedPath}") 로 여세요.`
      : `\n\n${OFFLOAD_MARKER} 전체 ${s.len.toLocaleString()}자 중 앞부분만 표시됨(저장 실패).`
    const replaced = preview + note
    freedChars += s.len - replaced.length
    total -= s.len - replaced.length
    s.r.content = replaced
    offloaded++
  }

  if (offloaded > 0) onOffload?.({ offloaded, freedChars })
  return offloaded
}

/**
 * **개별 MCP 도구 결과 상한 적용.** 상한을 넘으면 원문을 파일로 빼고 프리뷰 + 안내만 남긴다.
 *
 * ## 왜 자르지 않고 파일로 빼나
 *
 * 그냥 잘라 버리면 모델이 **뒷부분이 존재했다는 사실조차 모른다.** 페이지네이션이 있는 서버였다면
 * 다시 물어볼 수 있는데 그 판단 근거가 사라진다. 세 레퍼런스가 모두 같은 결론이다 —
 * openclaude `mcpOutputStorage`, opencode `Truncate`(outputPath), daiops per-turn offload.
 *
 * ## 문구가 상한 자체보다 중요하다
 *
 * openclaude 문구를 따라 **에러 형태**로 주고 **페이지네이션·필터 도구를 먼저 권한다.**
 * 종전 per-turn 안내("Read로 여세요")만 두면 모델이 20만 자 파일을 그대로 다시 읽으러 간다 —
 * 상한을 넣은 이유가 사라진다.
 *
 * per-turn 예산(`enforceTurnResultBudget`)과 **같은 마커**를 쓴다. 그래야 뒤이어 도는 per-turn
 * 패스가 이미 처리된 결과를 다시 오프로드하지 않는다(멱등).
 *
 * @param {{content: string | Array<unknown>, is_error?: boolean}} result — in-place mutate
 * @param {{ maxChars?: number, toolName?: string }} [opts]
 * @returns {Promise<boolean>} 상한을 적용했으면 true
 */
export async function enforceMcpResultCap(result, { maxChars, toolName } = {}) {
  if (!result) return false
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : MCP_RESULT_MAX_CHARS

  // 이미지 블록이 있으면 건드리지 않는다. base64를 JSON으로 굳히면 이미지 압축·재열람 경로가
  // 죽는다(openclaude도 `contentContainsImages`면 오프로드 대신 잘라내기로 폴백한다).
  if (Array.isArray(result.content) && result.content.some((c) => c && c.type === 'image')) {
    return false
  }
  const text = toText(result.content)
  if (text.length <= limit) return false
  // 이미 오프로드된 것은 다시 처리하지 않는다(per-turn 패스와 공유하는 멱등 조건).
  if (typeof result.content === 'string' && result.content.startsWith(OFFLOAD_MARKER)) return false

  const savedPath = await writeOffload(text)
  const preview = truncateMiddle(text, OFFLOAD_PREVIEW_CHARS)
  const where = savedPath
    ? `전체 ${text.length.toLocaleString()}자는 ${savedPath} 에 저장됐습니다. Read("${savedPath}") 로 부분씩 여세요.`
    : `전체 ${text.length.toLocaleString()}자 중 앞부분만 표시됩니다(저장 실패).`
  result.content =
    `${OFFLOAD_MARKER} 도구 결과가 상한(${limit.toLocaleString()}자)을 넘었습니다.\n` +
    `${where}\n` +
    // 이 한 줄이 핵심 — 다시 읽는 것보다 좁혀 묻는 것이 낫다는 방향을 준다.
    `이 MCP 서버에 페이지네이션·필터·검색 도구가 있으면 그것으로 필요한 부분만 다시 조회하세요` +
    `${toolName ? ` (호출한 도구: ${toolName})` : ''}.\n\n` +
    preview
  return true
}

/** 이미지 evict 시 남기는 플레이스홀더 마커(재-evict 무한 방지 = 멱등). */
export const IMAGE_EVICT_MARKER = '…[이미지 문맥에서 내림]'

function isImageBlock(blk) {
  return !!(blk && blk.type === 'image' && blk.source && typeof blk.source.data === 'string')
}

/** 같은 컨테이너의 텍스트 블록에서 원본 경로 추출 (read.js: `Image '<path>' (...)`). 없으면 null. */
function extractImagePath(container) {
  for (const b of container) {
    if (b && b.type === 'text' && typeof b.text === 'string') {
      const m = b.text.match(/Image '([^']+)'/)
      if (m) return m[1]
    }
  }
  return null
}

/**
 * 메시지 트리 전체에서 base64 이미지 블록을 시간순(오래된 것부터)으로 찾아, 최근 keepRecentImages개는
 * 보호하고 나머지를 경로 참조 텍스트로 치환한다(in-place). char 예산(enforceTurnResultBudget)이 못 잡는
 * 이미지 byte를 발신 전 크기 가드(turn-manager)에서 덜어내기 위한 수단.
 *
 * 원본 이미지는 샌드박스 FS(/workspace/.attachments 등)에 그대로 남아, 모델이 Read(path)로 재로드 가능.
 *
 * @param {Array<{role?:string, content?:unknown}>} messages
 * @param {{ bytesToFree?: number, keepRecentImages?: number }} [opts]
 *   bytesToFree: 최소 이만큼(base64 chars) 회수하면 중단. 미지정 시 evictable 전부.
 *   keepRecentImages: 가장 최근 N개 이미지는 보호(현재 turn 분석 대상 가능성). 기본 1.
 * @returns {{ evicted: number, freedBytes: number }}
 */
export function evictImagesForBudget(messages, { bytesToFree = Infinity, keepRecentImages = 1 } = {}) {
  if (!Array.isArray(messages)) return { evicted: 0, freedBytes: 0 }

  // 이미지 블록 수집 — 두 형태: (a) 메시지 top-level 블록, (b) tool_result.content 중첩 블록.
  const refs = []
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue
    for (let i = 0; i < m.content.length; i++) {
      const blk = m.content[i]
      if (isImageBlock(blk)) {
        refs.push({ container: m.content, index: i })
      } else if (blk && Array.isArray(blk.content)) {
        for (let j = 0; j < blk.content.length; j++) {
          if (isImageBlock(blk.content[j])) refs.push({ container: blk.content, index: j })
        }
      }
    }
  }

  // 최근 keepRecentImages개 보호 → 나머지를 오래된 것부터 evict.
  const evictable = refs.slice(0, Math.max(0, refs.length - Math.max(0, keepRecentImages)))
  let evicted = 0
  let freedBytes = 0
  for (const ref of evictable) {
    if (freedBytes >= bytesToFree) break
    const img = ref.container[ref.index]
    const path = extractImagePath(ref.container)
    freedBytes += img.source.data.length
    ref.container[ref.index] = {
      type: 'text',
      text: path
        ? `${IMAGE_EVICT_MARKER} 필요하면 Read("${path}") 로 다시 여세요.`
        : `${IMAGE_EVICT_MARKER} (원본 경로 미상)`,
    }
    evicted++
  }
  return { evicted, freedBytes }
}
