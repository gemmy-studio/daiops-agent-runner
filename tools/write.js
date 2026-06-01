/**
 * Write tool — 파일 생성/덮어쓰기. 시스템 경로 deny + DAIOPS_WRITE_SAFE_ROOT sandbox.
 *
 *  - 시스템 디렉토리 보호 (/etc, /usr, /proc 등).
 *  - DAIOPS_WRITE_SAFE_ROOT — 옵트인 sandbox 강화.
 *  - 부모 디렉토리 자동 생성 (mkdir -p).
 *
 * 본 도구는 cloud canUseTool 정책의 2차 가드. 1차는 cloud 정책 평가.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolvePath, resolveCwd, isWriteDenied } from './_common.js'

const MAX_WRITE_BYTES = 5 * 1024 * 1024

export const WRITE_TOOL = Object.freeze({
  name: 'Write',
  description: 'Write content to a file (creates or overwrites). Auto-creates parent directories. Refuses system paths.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or cwd-relative path. Tilde (~) supported.' },
      content: { type: 'string' },
    },
    required: ['file_path', 'content'],
  },
})

/**
 * @param {{file_path: string, content: string}} input
 * @param {{ cwd?: string, signal?: AbortSignal }} [ctx]
 * @returns {Promise<{content: string, is_error?: boolean}>}
 */
export async function runWrite(input, ctx = {}) {
  if (!input || typeof input.file_path !== 'string' || !input.file_path) {
    return { content: 'Write: file_path is required', is_error: true }
  }
  if (typeof input.content !== 'string') {
    return { content: 'Write: content must be a string', is_error: true }
  }
  const bytes = Buffer.byteLength(input.content, 'utf8')
  if (bytes > MAX_WRITE_BYTES) {
    return { content: `Write: content too large (${bytes} > ${MAX_WRITE_BYTES} bytes)`, is_error: true }
  }
  if (ctx.signal?.aborted) return { content: 'Write: aborted', is_error: true }

  const resolved = resolvePath(input.file_path, resolveCwd(ctx))
  const guard = isWriteDenied(resolved)
  if (guard.denied) {
    return { content: `Write: refused — ${guard.reason}`, is_error: true }
  }

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    await fs.writeFile(resolved, input.content, 'utf8')
    return { content: `Wrote ${resolved} (${bytes} bytes)` }
  } catch (err) {
    return { content: `Write: failed for '${resolved}': ${err.code ?? err.message}`, is_error: true }
  }
}
