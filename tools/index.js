/**
 * Built-in tool runtime — Anthropic 호환 tool 정의 + 실행 디스패처.
 *
 * Read/Edit/Glob/Grep/Bash/Write를 agent-runner가 직접 실행 (SDK 미사용).
 * handler.js의 SDK_BUILTIN_TOOLS와 정확히 같은 이름·시맨틱.
 *
 * 사용 패턴:
 *   import { BUILTIN_TOOLS, runBuiltinTool, BUILTIN_TOOL_NAMES } from './tools/index.js'
 *   const tools = BUILTIN_TOOLS // Anthropic tool 정의 배열
 *   await runBuiltinTool('Read', { file_path: 'a.ts' }, { cwd, signal })
 */

import { READ_TOOL, runRead } from './read.js'
import { WRITE_TOOL, runWrite } from './write.js'
import { EDIT_TOOL, runEdit } from './edit.js'
import { GLOB_TOOL, runGlob } from './glob.js'
import { GREP_TOOL, runGrep } from './grep.js'
import { BASH_TOOL, runBash } from './bash.js'
import { BASH_OUTPUT_TOOL, runBashOutput } from './bash-output.js'
import { KILL_SHELL_TOOL, runKillShell } from './kill-shell.js'

/** Anthropic 호환 tool 정의 배열 (input_schema 포함). */
export const BUILTIN_TOOLS = Object.freeze([
  READ_TOOL,
  WRITE_TOOL,
  EDIT_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  BASH_TOOL,
  BASH_OUTPUT_TOOL,
  KILL_SHELL_TOOL,
])

/** 빌트인 도구 이름 집합 — handler.js의 SDK_BUILTIN_TOOLS와 일치. */
export const BUILTIN_TOOL_NAMES = Object.freeze(BUILTIN_TOOLS.map((t) => t.name))

/** @type {Record<string, (input: any, ctx: any) => Promise<{content: string|Array<any>, is_error?: boolean}>>} */
const RUNNERS = {
  Read: runRead,
  Write: runWrite,
  Edit: runEdit,
  Glob: runGlob,
  Grep: runGrep,
  Bash: runBash,
  BashOutput: runBashOutput,
  KillShell: runKillShell,
}

/**
 * 도구 이름으로 디스패치. 알려지지 않은 이름은 is_error.
 *
 * @param {string} name
 * @param {unknown} input
 * @param {{ cwd?: string, signal?: AbortSignal, env?: Record<string,string> }} [ctx]
 * @returns {Promise<{content: string|Array<any>, is_error?: boolean}>}
 */
export async function runBuiltinTool(name, input, ctx = {}) {
  const runner = RUNNERS[name]
  if (!runner) {
    return { content: `Tool '${name}' is not a registered builtin`, is_error: true }
  }
  return runner(/** @type {any} */ (input ?? {}), ctx)
}

/**
 * 도구 이름이 빌트인 도구 집합에 속하는지 확인.
 * (handler.js의 SDK_BUILTIN_TOOLS 체크와 동등 — MCP 프리픽스 도구와 구분 위해 사용.)
 *
 * @param {string} name
 */
export function isBuiltinTool(name) {
  return Object.prototype.hasOwnProperty.call(RUNNERS, name)
}
