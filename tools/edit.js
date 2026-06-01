/**
 * Edit tool — old_string → new_string 정확 치환 + 응답에 unified diff 첨부.
 *
 *  - 모호한 다중 매칭 → 에러 + 개수 표시 (replace_all로만 허용).
 *  - 수정 후 unified diff 반환 — LLM이 실제 적용 결과를 다시 확인 가능.
 *  - 쓰기 가드 (Write tool과 동일 deny list).
 *
 * 단순성 우선: fuzzy 매칭은 미지원. LLM은 exact match를 다룰 수 있음.
 */

import { promises as fs } from 'node:fs'
import { resolvePath, resolveCwd, isWriteDenied, safeStat } from './_common.js'

const MAX_FILE_BYTES = 5 * 1024 * 1024

export const EDIT_TOOL = Object.freeze({
  name: 'Edit',
  description: 'Replace old_string with new_string in a file. Fails if old_string is missing or appears multiple times (use replace_all to substitute all). Returns a unified diff of the change.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact substring to replace. Must be unique unless replace_all=true.' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean', default: false },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
})

/**
 * @param {{file_path: string, old_string: string, new_string: string, replace_all?: boolean}} input
 * @param {{ cwd?: string, signal?: AbortSignal }} [ctx]
 * @returns {Promise<{content: string, is_error?: boolean}>}
 */
export async function runEdit(input, ctx = {}) {
  if (!input || typeof input.file_path !== 'string' || !input.file_path) {
    return { content: 'Edit: file_path is required', is_error: true }
  }
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
    return { content: 'Edit: old_string and new_string must be strings', is_error: true }
  }
  if (input.old_string === input.new_string) {
    return { content: 'Edit: old_string and new_string are identical (no-op)', is_error: true }
  }
  if (ctx.signal?.aborted) return { content: 'Edit: aborted', is_error: true }

  const resolved = resolvePath(input.file_path, resolveCwd(ctx))
  const guard = isWriteDenied(resolved)
  if (guard.denied) {
    return { content: `Edit: refused — ${guard.reason}`, is_error: true }
  }

  const stat = await safeStat(resolved)
  if (!stat) {
    return { content: `Edit: cannot stat '${resolved}'`, is_error: true }
  }
  if (stat.size > MAX_FILE_BYTES) {
    return { content: `Edit: file too large (${stat.size} > ${MAX_FILE_BYTES} bytes)`, is_error: true }
  }

  let raw
  try {
    raw = await fs.readFile(resolved, 'utf8')
  } catch (err) {
    return { content: `Edit: cannot read '${resolved}': ${err.code ?? err.message}`, is_error: true }
  }

  const occurrences = countOccurrences(raw, input.old_string)
  if (occurrences === 0) {
    return { content: `Edit: old_string not found in '${resolved}'`, is_error: true }
  }
  if (occurrences > 1 && !input.replace_all) {
    return {
      content: `Edit: old_string matches ${occurrences} times in '${resolved}'. Set replace_all=true or provide more surrounding context.`,
      is_error: true,
    }
  }

  const next = input.replace_all
    ? raw.split(input.old_string).join(input.new_string)
    : raw.replace(input.old_string, input.new_string)

  try {
    await fs.writeFile(resolved, next, 'utf8')
  } catch (err) {
    return { content: `Edit: write failed for '${resolved}': ${err.code ?? err.message}`, is_error: true }
  }

  // unified diff — 라이브러리 없이 단순 라인 비교 (LLM은 흐름만 봐도 충분).
  const diff = simpleUnifiedDiff(raw, next, resolved)
  const summary = `Edited ${resolved} (${occurrences} replacement${occurrences > 1 ? 's' : ''})`
  return { content: `${summary}\n\n${diff}` }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

/**
 * 간단한 unified diff (라이브러리 없이). 변경된 hunk만 — 첫 변경 라인부터
 * 마지막 변경 라인까지 + 양쪽 컨텍스트 3줄.
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {string} filename
 */
function simpleUnifiedDiff(oldText, newText, filename) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  /** @type {string[]} */
  const hunks = []
  hunks.push(`--- a/${filename}`)
  hunks.push(`+++ b/${filename}`)

  let i = 0, j = 0
  const out = []
  const MAX_HUNK_LINES = 200
  while (i < oldLines.length || j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push(` ${oldLines[i] ?? ''}`)
      i++; j++
    } else {
      if (oldLines[i] !== undefined) { out.push(`-${oldLines[i]}`); i++ }
      if (newLines[j] !== undefined) { out.push(`+${newLines[j]}`); j++ }
    }
    if (out.length >= MAX_HUNK_LINES) {
      out.push('… [diff truncated]')
      break
    }
  }
  // 변경이 없는 prefix/suffix는 trim 안 함 (단순성). LLM이 어차피 작은 변경 위주.
  return [hunks.join('\n'), out.join('\n')].join('\n')
}
