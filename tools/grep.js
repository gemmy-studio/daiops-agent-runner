/**
 * Grep tool — 디렉토리 트리 정규식 검색.
 *
 *  - 3개 output 모드: content / files_with_matches / count.
 *  - 컨텍스트 라인 옵션 (-A/-B/-C) — content 모드에서 매칭 라인 주변 노출.
 *  - 바이너리 파일 skip (확장자 + 내용 sniff).
 *  - 출력 크기 상한 (MAX_OUTPUT_BYTES) — 큰 코드베이스에서 응답 폭주 방지.
 *
 * daiops: node_modules/.git 자동 skip (디폴트 안전). cwd 기본 '/workspace'.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolvePath, resolveCwd, isBinaryByExtension, isBinaryByContent } from './_common.js'

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_TRAVERSAL_FILES = 50_000
const MAX_FILE_BYTES = 5 * 1024 * 1024
/** 워크스페이스 walk 시 자동 skip 디렉토리. */
const AUTO_SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.venv', '__pycache__'])

export const GREP_TOOL = Object.freeze({
  name: 'Grep',
  description: 'Search files in a directory tree for a regex pattern. Modes: files_with_matches (default — just paths), content (matching lines), count (per-file counts). Supports -i (case-insensitive), -A/-B/-C (context lines).',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JS regex pattern' },
      path: { type: 'string', description: 'Root directory (default: cwd)' },
      glob: { type: 'string', description: 'File glob filter (e.g. "**/*.ts")' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], default: 'files_with_matches' },
      '-i': { type: 'boolean', description: 'case-insensitive', default: false },
      '-n': { type: 'boolean', description: 'show line numbers (content mode)', default: true },
      '-A': { type: 'number', description: 'lines of trailing context (content mode)', minimum: 0 },
      '-B': { type: 'number', description: 'lines of leading context (content mode)', minimum: 0 },
      '-C': { type: 'number', description: 'lines of both leading + trailing context (content mode)', minimum: 0 },
    },
    required: ['pattern'],
  },
})

/**
 * @param {{pattern: string, path?: string, glob?: string, output_mode?: string, '-i'?: boolean, '-n'?: boolean, '-A'?: number, '-B'?: number, '-C'?: number}} input
 * @param {{ cwd?: string, signal?: AbortSignal }} [ctx]
 * @returns {Promise<{content: string, is_error?: boolean}>}
 */
export async function runGrep(input, ctx = {}) {
  if (!input || typeof input.pattern !== 'string' || !input.pattern) {
    return { content: 'Grep: pattern is required', is_error: true }
  }
  // ReDoS 완화 — 과도하게 긴 패턴은 catastrophic backtracking 위험이 커 거부한다.
  if (input.pattern.length > 1000) {
    return { content: 'Grep: pattern too long (max 1000 chars)', is_error: true }
  }
  if (ctx.signal?.aborted) return { content: 'Grep: aborted', is_error: true }

  let re
  try {
    re = new RegExp(input.pattern, input['-i'] ? 'i' : '')
  } catch (err) {
    return { content: `Grep: invalid regex: ${err.message}`, is_error: true }
  }

  const cwd = resolveCwd(ctx)
  const rootPath = input.path ? resolvePath(input.path, cwd) : cwd
  const outputMode = input.output_mode ?? 'files_with_matches'
  const showLineNumbers = input['-n'] !== false
  const ctxAfter = input['-C'] ?? input['-A'] ?? 0
  const ctxBefore = input['-C'] ?? input['-B'] ?? 0

  // 파일 후보 수집
  /** @type {string[]} */
  const files = []
  try {
    if (input.glob) {
      const iter = fs.glob(input.glob, { cwd: rootPath, withFileTypes: false })
      for await (const m of iter) {
        if (ctx.signal?.aborted) break
        const abs = path.isAbsolute(m) ? m : path.join(rootPath, m)
        files.push(abs)
        if (files.length >= MAX_TRAVERSAL_FILES) break
      }
    } else {
      await walkDir(rootPath, files, ctx.signal)
    }
  } catch (err) {
    return { content: `Grep: traversal failed: ${err.code ?? err.message}`, is_error: true }
  }

  /** @type {string[]} */
  const out = []
  let outputBytes = 0
  let totalMatches = 0

  for (const f of files) {
    if (ctx.signal?.aborted) break
    if (isBinaryByExtension(f)) continue

    let stat
    try {
      stat = await fs.stat(f)
    } catch { continue }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue

    let buf
    try {
      buf = await fs.readFile(f)
    } catch { continue }
    if (isBinaryByContent(buf)) continue
    const text = buf.toString('utf8')

    if (outputMode === 'files_with_matches') {
      if (re.test(text)) {
        out.push(f)
        outputBytes += f.length + 1
      }
    } else if (outputMode === 'count') {
      const lines = text.split('\n')
      let cnt = 0
      for (const line of lines) if (re.test(line)) cnt++
      if (cnt > 0) {
        const row = `${f}:${cnt}`
        out.push(row)
        outputBytes += row.length + 1
        totalMatches += cnt
      }
    } else { // content
      const lines = text.split('\n')
      const matchIdx = []
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) matchIdx.push(i)
      if (matchIdx.length === 0) continue

      // 컨텍스트 라인 union — 인접 매칭은 하나의 hunk로 병합
      /** @type {Array<{from:number,to:number}>} */
      const ranges = []
      for (const m of matchIdx) {
        const from = Math.max(0, m - ctxBefore)
        const to = Math.min(lines.length - 1, m + ctxAfter)
        const last = ranges[ranges.length - 1]
        if (last && from <= last.to + 1) {
          last.to = Math.max(last.to, to)
        } else {
          ranges.push({ from, to })
        }
      }

      for (const range of ranges) {
        if (out.length > 0 && (ctxBefore > 0 || ctxAfter > 0)) out.push('--')
        for (let i = range.from; i <= range.to; i++) {
          const marker = matchIdx.includes(i) ? ':' : '-' // match=콜론, context=하이픈
          const row = showLineNumbers ? `${f}${marker}${i + 1}${marker}${lines[i]}` : `${f}${marker}${lines[i]}`
          out.push(row)
          outputBytes += row.length + 1
          totalMatches++
          if (outputBytes > MAX_OUTPUT_BYTES) break
        }
        if (outputBytes > MAX_OUTPUT_BYTES) break
      }
    }
    if (outputBytes > MAX_OUTPUT_BYTES) {
      out.push(`[…output truncated at ${MAX_OUTPUT_BYTES} bytes]`)
      break
    }
  }

  if (out.length === 0) return { content: 'Grep: no matches' }
  return { content: out.join('\n') }
}

/**
 * @param {string} dir
 * @param {string[]} out
 * @param {AbortSignal | undefined} signal
 */
async function walkDir(dir, out, signal) {
  if (signal?.aborted) return
  if (out.length >= MAX_TRAVERSAL_FILES) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (signal?.aborted) return
    if (AUTO_SKIP_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('.') && !['.env.example', '.gitignore', '.eslintrc'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(full, out, signal)
    } else if (entry.isFile()) {
      out.push(full)
      if (out.length >= MAX_TRAVERSAL_FILES) return
    }
  }
}
