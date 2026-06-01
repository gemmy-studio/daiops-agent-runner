import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { hasActiveJobs, sendKeepalive, ensureJobKeepalive, stopJobKeepalive } from './job-keepalive.js'

const DEAD_PID = 2147483646 // 거의 확실히 존재하지 않는 pid → ESRCH

async function withJobsDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keepalive-jobs-'))
  const prev = process.env.AGENT_RUNNER_JOBS_DIR
  process.env.AGENT_RUNNER_JOBS_DIR = dir
  try {
    return await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.AGENT_RUNNER_JOBS_DIR
    else process.env.AGENT_RUNNER_JOBS_DIR = prev
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function writeJob(dir, jobId, meta, { exit } = {}) {
  await fs.writeFile(path.join(dir, `${jobId}.meta.json`), JSON.stringify({ job_id: jobId, ...meta }))
  if (exit !== undefined) await fs.writeFile(path.join(dir, `${jobId}.exit`), String(exit))
}

describe('hasActiveJobs', () => {
  it('살아있는 + 미종료 + 2h 이내 잡 → true', async () => {
    await withJobsDir(async (dir) => {
      await writeJob(dir, 'active', { pid: process.pid, startedAt: new Date().toISOString(), status: 'running' })
      assert.equal(await hasActiveJobs(), true)
    })
  })

  it('exit sentinel 있으면 → 스킵', async () => {
    await withJobsDir(async (dir) => {
      await writeJob(dir, 'done', { pid: process.pid, startedAt: new Date().toISOString(), status: 'running' }, { exit: 0 })
      assert.equal(await hasActiveJobs(), false)
    })
  })

  it('2h 초과 잡 → 스킵 (stuck 방지)', async () => {
    await withJobsDir(async (dir) => {
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
      await writeJob(dir, 'stuck', { pid: process.pid, startedAt: old, status: 'running' })
      assert.equal(await hasActiveJobs(), false)
    })
  })

  it('죽은 pid → 스킵', async () => {
    await withJobsDir(async (dir) => {
      await writeJob(dir, 'dead', { pid: DEAD_PID, startedAt: new Date().toISOString(), status: 'running' })
      assert.equal(await hasActiveJobs(), false)
    })
  })

  it('여러 잡 중 하나라도 활성이면 true', async () => {
    await withJobsDir(async (dir) => {
      await writeJob(dir, 'done', { pid: process.pid, startedAt: new Date().toISOString() }, { exit: 0 })
      await writeJob(dir, 'dead', { pid: DEAD_PID, startedAt: new Date().toISOString() })
      await writeJob(dir, 'active', { pid: process.pid, startedAt: new Date().toISOString() })
      assert.equal(await hasActiveJobs(), true)
    })
  })

  it('jobs 디렉토리 없음 → false', async () => {
    const prev = process.env.AGENT_RUNNER_JOBS_DIR
    process.env.AGENT_RUNNER_JOBS_DIR = path.join(os.tmpdir(), 'keepalive-nonexistent-xyz')
    try {
      assert.equal(await hasActiveJobs(), false)
    } finally {
      if (prev === undefined) delete process.env.AGENT_RUNNER_JOBS_DIR
      else process.env.AGENT_RUNNER_JOBS_DIR = prev
    }
  })
})

describe('sendKeepalive', () => {
  function withEnv(env, fn) {
    const keys = ['LLM_PROXY_URL', 'AGENT_RUNNER_TOKEN', 'WORKSPACE_ID']
    const saved = {}
    for (const k of keys) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
    return Promise.resolve(fn()).finally(() => {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    })
  }

  it('env 미설정 → no-op false', async () => {
    await withEnv({ LLM_PROXY_URL: undefined, AGENT_RUNNER_TOKEN: undefined, WORKSPACE_ID: undefined }, async () => {
      let called = false
      const r = await sendKeepalive(async () => { called = true; return new Response('{}') })
      assert.equal(r, false)
      assert.equal(called, false)
    })
  })

  it('env 설정 → LLM_PROXY_URL origin + /api/internal/sandbox/keepalive로 인증 헤더 POST', async () => {
    await withEnv({
      LLM_PROXY_URL: 'https://cloud.example/api/internal/llm/messages',
      AGENT_RUNNER_TOKEN: 'ws-tok',
      WORKSPACE_ID: 'ws-1',
    }, async () => {
      let captured
      const r = await sendKeepalive(async (url, init) => { captured = { url, init }; return new Response('{}', { status: 200 }) })
      assert.equal(r, true)
      assert.equal(captured.url, 'https://cloud.example/api/internal/sandbox/keepalive')
      assert.equal(captured.init.method, 'POST')
      assert.equal(captured.init.headers['authorization'], 'Bearer ws-tok')
      assert.equal(captured.init.headers['x-workspace-id'], 'ws-1')
    })
  })

  it('upstream !ok → false', async () => {
    await withEnv({
      LLM_PROXY_URL: 'https://cloud.example/x', AGENT_RUNNER_TOKEN: 't', WORKSPACE_ID: 'w',
    }, async () => {
      const r = await sendKeepalive(async () => new Response('err', { status: 502 }))
      assert.equal(r, false)
    })
  })
})

describe('ensureJobKeepalive', () => {
  it('LLM_PROXY_URL 미설정 → 인터벌 시작 안 함(tick 미발생)', async () => {
    const prev = process.env.LLM_PROXY_URL
    delete process.env.LLM_PROXY_URL
    try {
      let called = false
      ensureJobKeepalive({ intervalMs: 5, fetchFn: async () => { called = true; return new Response('{}') } })
      await new Promise((res) => setTimeout(res, 30))
      assert.equal(called, false)
    } finally {
      stopJobKeepalive()
      if (prev === undefined) delete process.env.LLM_PROXY_URL
      else process.env.LLM_PROXY_URL = prev
    }
  })

  it('활성 잡 있으면 tick이 sendKeepalive 호출', async () => {
    await withJobsDir(async (dir) => {
      await writeJob(dir, 'active', { pid: process.pid, startedAt: new Date().toISOString() })
      const saved = { p: process.env.LLM_PROXY_URL, t: process.env.AGENT_RUNNER_TOKEN, w: process.env.WORKSPACE_ID }
      process.env.LLM_PROXY_URL = 'https://cloud.example/api/internal/llm/messages'
      process.env.AGENT_RUNNER_TOKEN = 'tok'
      process.env.WORKSPACE_ID = 'ws'
      let calls = 0
      try {
        ensureJobKeepalive({ intervalMs: 10, fetchFn: async () => { calls++; return new Response('{}', { status: 200 }) } })
        await new Promise((res) => setTimeout(res, 60))
        assert.ok(calls >= 1, `expected keepalive call, got ${calls}`)
      } finally {
        stopJobKeepalive()
        if (saved.p === undefined) delete process.env.LLM_PROXY_URL; else process.env.LLM_PROXY_URL = saved.p
        if (saved.t === undefined) delete process.env.AGENT_RUNNER_TOKEN; else process.env.AGENT_RUNNER_TOKEN = saved.t
        if (saved.w === undefined) delete process.env.WORKSPACE_ID; else process.env.WORKSPACE_ID = saved.w
      }
    })
  })
})
