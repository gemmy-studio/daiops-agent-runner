/**
 * Glob tool — fs.glob 기반 패턴 매칭. mtime desc 정렬, 상한 200개.
 *
 *  - path: 검색 루트 (기본 ctx.cwd / '/workspace'). 절대 또는 cwd 상대.
 *  - 글로브스타(**), 단일 (*), ? 지원 (Node 22+ fs.glob).
 *  - node_modules/.git 자동 제외 안 됨 (glob 패턴에 명시 필요).
 *  - 결과: 절대 경로 라인. mtime 최신순 정렬.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolvePath, resolveCwd } from './_common.js'

const MAX_RESULTS = 200
const MAX_TRAVERSAL_FILES = 50_000

export const GLOB_TOOL = Object.freeze({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns absolute paths sorted by mtime (newest first), up to 200 results. Supports globstar (**), wildcards (*, ?).',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts")' },
      path: { type: 'string', description: 'Root directory (default: cwd)' },
    },
    required: ['pattern'],
  },
})

/**
 * @param {{pattern: string, path?: string}} input
 * @param {{ cwd?: string, signal?: AbortSignal }} [ctx]
 * @returns {Promise<{content: string, is_error?: boolean}>}
 */
export async function runGlob(input, ctx = {}) {
  if (!input || typeof input.pattern !== 'string' || !input.pattern) {
    return { content: 'Glob: pattern is required', is_error: true }
  }
  if (ctx.signal?.aborted) return { content: 'Glob: aborted', is_error: true }

  const cwd = resolveCwd(ctx)
  const rootPath = input.path ? resolvePath(input.path, cwd) : cwd

  /** @type {string[]} */
  let matches = []
  try {
    const iter = fs.glob(input.pattern, { cwd: rootPath, withFileTypes: false })
    for await (const m of iter) {
      if (ctx.signal?.aborted) break
      const abs = path.isAbsolute(m) ? m : path.join(rootPath, m)
      matches.push(abs)
      if (matches.length >= MAX_TRAVERSAL_FILES) break
    }
  } catch (err) {
    return { content: `Glob: failed: ${err.code ?? err.message}`, is_error: true }
  }

  /** @type {Array<{ path: string, mtime: number }>} */
  const enriched = []
  for (const p of matches) {
    try {
      const s = await fs.stat(p)
      enriched.push({ path: p, mtime: s.mtimeMs })
    } catch {
      enriched.push({ path: p, mtime: 0 })
    }
  }
  enriched.sort((a, b) => b.mtime - a.mtime)

  const truncated = enriched.length > MAX_RESULTS
  const out = enriched.slice(0, MAX_RESULTS).map((e) => e.path).join('\n')
  if (out.length === 0) return { content: 'Glob: no matches' }
  return {
    content: truncated
      ? `${out}\n[…and ${enriched.length - MAX_RESULTS} more, sorted by mtime desc]`
      : out,
  }
}
