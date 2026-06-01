/**
 * Read tool — 파일 텍스트를 라인 번호 형식(`      N|content`)으로 반환.
 *
 *  - 페이지네이션 (offset 1-based + limit, 기본 500/최대 2000).
 *  - 확장자 우선 바이너리 감지 + 내용 sniff fallback.
 *  - 이미지 확장자는 별도 안내 (vision 미통합 — 안내만 반환).
 *  - 파일 크기 상한 초과 시 head + 명시적 truncated 안내.
 *
 * daiops 적응: 모든 경로는 ctx.cwd(기본 '/workspace') 기준, `~`/`~/` 확장 지원.
 */

import { promises as fs } from 'node:fs'
import {
  resolvePath,
  resolveCwd,
  safeStat,
  isBinaryByExtension,
  isBinaryByContent,
  formatNumberedLines,
  IMAGE_EXTENSIONS,
  MAX_FILE_SIZE,
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
} from './_common.js'
import path from 'node:path'

export const READ_TOOL = Object.freeze({
  name: 'Read',
  description: 'Read a file from the local filesystem with optional line range. Returns content with line numbers in "      N|content" format. Default 500 lines starting from line 1.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or cwd-relative path. Tilde (~) supported.' },
      offset: { type: 'number', description: '1-based start line', minimum: 1 },
      limit: { type: 'number', description: 'Number of lines to read (max 2000, default 500)', minimum: 1 },
    },
    required: ['file_path'],
  },
})

/**
 * @param {{file_path: string, offset?: number, limit?: number}} input
 * @param {{ cwd?: string, signal?: AbortSignal }} [ctx]
 * @returns {Promise<{content: string, is_error?: boolean}>}
 */
export async function runRead(input, ctx = {}) {
  if (!input || typeof input.file_path !== 'string' || !input.file_path) {
    return { content: 'Read: file_path is required', is_error: true }
  }
  if (ctx.signal?.aborted) return { content: 'Read: aborted', is_error: true }

  const resolved = resolvePath(input.file_path, resolveCwd(ctx))
  const stat = await safeStat(resolved)
  if (!stat) {
    return { content: `Read: cannot stat '${resolved}' (not found or permission denied)`, is_error: true }
  }
  if (stat.isDirectory()) {
    return { content: `Read: '${resolved}' is a directory, not a file`, is_error: true }
  }

  // 이미지: 안내만 반환 (vision 미통합 — 별도 흐름)
  const ext = path.extname(resolved).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      content: `Read: '${resolved}' is an image (${ext}, ${stat.size} bytes). Use a vision-capable tool to inspect contents.`,
      is_error: true,
    }
  }
  if (isBinaryByExtension(resolved)) {
    return { content: `Read: '${resolved}' has a binary extension (${ext})`, is_error: true }
  }

  // 큰 파일은 head만 읽고 truncated 안내.
  const readSize = Math.min(stat.size, MAX_FILE_SIZE)
  const truncatedAtBytes = stat.size > MAX_FILE_SIZE
  let buf
  try {
    if (truncatedAtBytes) {
      const fh = await fs.open(resolved, 'r')
      try {
        buf = Buffer.alloc(readSize)
        const { bytesRead } = await fh.read(buf, 0, readSize, 0)
        buf = buf.subarray(0, bytesRead)
      } finally {
        await fh.close()
      }
    } else {
      buf = await fs.readFile(resolved)
    }
  } catch (err) {
    return { content: `Read: read failed for '${resolved}': ${err.code ?? err.message}`, is_error: true }
  }

  if (isBinaryByContent(buf)) {
    return { content: `Read: '${resolved}' appears to be binary (content sniff)`, is_error: true }
  }

  const raw = buf.toString('utf8')
  const lines = raw.split('\n')
  const offset = Math.max(1, input.offset ?? 1)
  const limit = Math.min(MAX_READ_LIMIT, Math.max(1, input.limit ?? DEFAULT_READ_LIMIT))
  const startIdx = offset - 1
  const endIdx = Math.min(lines.length, startIdx + limit)

  if (startIdx >= lines.length) {
    return { content: `Read: offset=${offset} exceeds total lines (${lines.length})`, is_error: true }
  }

  const pageLines = lines.slice(startIdx, endIdx)
  let content = formatNumberedLines(pageLines, offset)

  const hasMore = endIdx < lines.length
  const notes = []
  if (truncatedAtBytes) notes.push(`file truncated at ${MAX_FILE_SIZE} bytes (original size=${stat.size})`)
  if (hasMore) notes.push(`showing lines ${offset}..${endIdx} of ${lines.length}; pass offset=${endIdx + 1} to continue`)
  if (notes.length > 0) content += `\n[${notes.join('; ')}]`
  if (content.length === 0) content = '(empty file)'

  return { content }
}
