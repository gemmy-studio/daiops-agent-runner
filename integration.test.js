/**
 * 통합 시나리오.
 * 개별 모듈 단위 테스트와 별개로, 서브시스템이 함께 동작하는 end-to-end 경로를 검증한다.
 *  - 백그라운드 잡 lifecycle(run_in_background → BashOutput/KillShell) + keepalive 활성 인식
 *  - MCP Streamable HTTP(SSE) 응답 서버에서 listTools + callTool
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { runBash } from './tools/bash.js'
import { runBashOutput } from './tools/bash-output.js'
import { runKillShell } from './tools/kill-shell.js'
import { hasActiveJobs } from './job-keepalive.js'
import { createMcpHttpClient } from './mcp-client.js'

describe('백그라운드 잡 lifecycle + keepalive 연동', () => {
  it('bg 시작 → hasActiveJobs true → BashOutput running → KillShell → 비활성', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'integ-jobs-'))
    const prev = process.env.AGENT_RUNNER_JOBS_DIR
    process.env.AGENT_RUNNER_JOBS_DIR = dir
    try {
      const r = await runBash({ command: 'sleep 30', run_in_background: true })
      const { job_id } = JSON.parse(r.content)

      // keepalive 스캔이 이 잡을 활성으로 인식
      await new Promise((res) => setTimeout(res, 60))
      assert.equal(await hasActiveJobs(), true)

      // BashOutput running
      const out = await runBashOutput({ job_id })
      assert.ok(out.content.includes('status=running'), out.content)

      // KillShell 종료
      const killed = await runKillShell({ job_id })
      assert.ok(/stopped|already exited/.test(killed.content), killed.content)

      // 종료 후 keepalive 비활성 전환
      let active = true
      for (let i = 0; i < 80 && active; i++) {
        await new Promise((res) => setTimeout(res, 20))
        active = await hasActiveJobs()
      }
      assert.equal(active, false)
    } finally {
      if (prev === undefined) delete process.env.AGENT_RUNNER_JOBS_DIR
      else process.env.AGENT_RUNNER_JOBS_DIR = prev
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('짧은 bg 잡 정상 종료 → BashOutput exit code 회수', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'integ-jobs-'))
    const prev = process.env.AGENT_RUNNER_JOBS_DIR
    process.env.AGENT_RUNNER_JOBS_DIR = dir
    try {
      const r = await runBash({ command: 'echo done; exit 0', run_in_background: true })
      const { job_id } = JSON.parse(r.content)
      let out
      for (let i = 0; i < 80; i++) {
        out = await runBashOutput({ job_id })
        if (out.content.includes('status=exited')) break
        await new Promise((res) => setTimeout(res, 20))
      }
      assert.ok(out.content.includes('status=exited') && out.content.includes('exit=0'), out.content)
      assert.ok(out.content.includes('done'))
      assert.equal(out.is_error, undefined)
      // 종료된 잡은 keepalive 비활성
      assert.equal(await hasActiveJobs(), false)
    } finally {
      if (prev === undefined) delete process.env.AGENT_RUNNER_JOBS_DIR
      else process.env.AGENT_RUNNER_JOBS_DIR = prev
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('MCP Streamable HTTP(SSE) end-to-end', () => {
  it('SSE 응답 + Mcp-Session-Id 서버에서 listTools + callTool', async () => {
    const sse = (id, result) => new Response(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' } },
    )
    const seen = []
    const fetchFn = async (_url, init) => {
      const body = JSON.parse(init.body)
      seen.push({ method: body.method, session: init.headers['mcp-session-id'] })
      if (body.method?.startsWith('notifications/')) return new Response('', { status: 200 })
      if (body.method === 'initialize') return sse(body.id, { protocolVersion: '2025-06-18', capabilities: {} })
      if (body.method === 'tools/list') return sse(body.id, { tools: [{ name: 'search', description: 's', inputSchema: { type: 'object' } }] })
      if (body.method === 'tools/call') return sse(body.id, { content: [{ type: 'text', text: 'mcp-result' }] })
      return sse(body.id, {})
    }
    const c = createMcpHttpClient({ name: 'wiki', url: 'http://mock' }, { fetchFn })
    const tools = await c.listTools()
    assert.deepEqual(tools.map((t) => t.name), ['search'])
    const res = await c.callTool('search', { q: 'x' })
    assert.equal(res.content, 'mcp-result')
    // initialize 이후 호출에 Mcp-Session-Id 동봉됐는지
    const callAfter = seen.find((s) => s.method === 'tools/call')
    assert.equal(callAfter.session, 'sess-1')
  })
})
