import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// 세마포어 상한을 결정적으로 고정한 뒤 import (모듈 로드 시 MAX_HEAVY_TOOLS 캡처).
process.env.AGENT_RUNNER_MAX_HEAVY_TOOLS = '2'
process.env.AGENT_RUNNER_HEAVY_NICE = '10'

const {
  isHeavyCommand,
  buildSpawnArgs,
  acquireHeavyLane,
  heavyLaneStats,
  nicePath,
  MAX_HEAVY_TOOLS,
  HEAVY_NICE,
} = await import('./tool-cpu-lane.js')

const tick = () => new Promise((r) => setImmediate(r))

describe('isHeavyCommand', () => {
  it('무거운 명령을 분류한다', () => {
    const heavy = [
      'node /opt/document-core/cli.js readPdf x.pdf > .cache/x.md',
      'node /opt/document-hwp/cli.js read a.hwp',
      'node /opt/document-image/cli.js ocr img.png',
      'python3 /home/daytona/analyze.py',
      'python script.py --flag',
      'pip install pandas',
      'npm install',
      'pnpm add foo',
      'ffmpeg -i a.mp4 b.mp4',
      'convert a.png b.jpg',
    ]
    for (const cmd of heavy) assert.equal(isHeavyCommand(cmd), true, `heavy: ${cmd}`)
  })

  it('경량 명령은 heavy로 잡지 않는다', () => {
    const light = [
      'ls -la',
      'cat foo.txt',
      'git status',
      'echo hello',
      'grep -r foo src',
      'node --version',
      'python3 --version',
      'python3 -c "print(1)"', // REPL 단발은 제외
      'cd /workspace && pwd',
      'mkdir -p .cache',
    ]
    for (const cmd of light) assert.equal(isHeavyCommand(cmd), false, `light: ${cmd}`)
  })

  it('비문자열/빈 입력은 false', () => {
    assert.equal(isHeavyCommand(undefined), false)
    assert.equal(isHeavyCommand(''), false)
    assert.equal(isHeavyCommand(null), false)
  })
})

describe('buildSpawnArgs', () => {
  it('경량은 /bin/bash 직접 실행', () => {
    const { file, args } = buildSpawnArgs(false, ['-c', 'ls'])
    assert.equal(file, '/bin/bash')
    assert.deepEqual(args, ['-c', 'ls'])
  })

  it('무거움은 nice 존재 시 nice로 래핑, 없으면 /bin/bash 폴백', () => {
    const np = nicePath()
    const { file, args } = buildSpawnArgs(true, ['-c', 'python3 x.py'])
    if (np) {
      assert.equal(file, np)
      assert.deepEqual(args, ['-n', String(HEAVY_NICE), '/bin/bash', '-c', 'python3 x.py'])
    } else {
      assert.equal(file, '/bin/bash')
      assert.deepEqual(args, ['-c', 'python3 x.py'])
    }
  })
})

describe('heavy lane semaphore', () => {
  it('MAX_HEAVY_TOOLS는 env override를 따른다', () => {
    assert.equal(MAX_HEAVY_TOOLS, 2)
  })

  it('상한 초과 acquire는 release 전까지 대기하고, 슬롯을 넘겨받는다', async () => {
    assert.deepEqual(heavyLaneStats(), { active: 0, waiting: 0, max: 2 })

    const r1 = await acquireHeavyLane()
    const r2 = await acquireHeavyLane()
    assert.equal(heavyLaneStats().active, 2)

    let r3resolved = false
    const p3 = acquireHeavyLane().then((r) => {
      r3resolved = true
      return r
    })
    await tick()
    // 상한(2) 도달 → 3번째는 대기.
    assert.equal(r3resolved, false)
    assert.deepEqual(heavyLaneStats(), { active: 2, waiting: 1, max: 2 })

    // 하나 반납 → 대기자에게 슬롯 핸드오버(active는 2 유지, 초과하지 않음).
    r1()
    const r3 = await p3
    assert.equal(r3resolved, true)
    assert.equal(heavyLaneStats().active, 2)
    assert.equal(heavyLaneStats().waiting, 0)

    r2()
    r3()
    assert.deepEqual(heavyLaneStats(), { active: 0, waiting: 0, max: 2 })
  })

  it('release는 멱등 — 두 번 호출해도 active가 음수로 가지 않는다', async () => {
    const r = await acquireHeavyLane()
    assert.equal(heavyLaneStats().active, 1)
    r()
    r()
    assert.equal(heavyLaneStats().active, 0)
  })
})
