import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePolicy, bashWritesProtectedPath } from './handler.js'

// 회귀 R2 2-a: 거버넌스 경로 판정은 「경로 언급 + 쓰기 낱말」이 아니라 **쓰기 목적지**를 본다.
// 사례는 회귀 검토 원문(`regression/r2-bash.mjs`)을 그대로 옮겼다.
const full = { security: 'full', ask: 'off', askFallback: 'full', allowlist: [], sandboxRoot: '/workspace', toolOverrides: { deny: [], ask: [], askSoft: [] } }
const decide = (command, ui = false) => evaluatePolicy(full, 'Bash', { command }, ui)

describe('보호 경로를 읽기만 하거나 밖으로 쓰는 명령은 통과', () => {
  for (const command of [
    'echo "$(date)"',
    'cat /workspace/.daiops/skills/active/report/SKILL.md',
    'cat /workspace/.daiops/skills/active/npm-install-guide/SKILL.md',
    'cat .daiops/skills/active/patch-notes/SKILL.md',
    'ls /workspace/.daiops/skills/active > /tmp/skills.txt',
    'cp /workspace/.daiops/skills/active/report/templates/base.docx /workspace/output/',
    'python3 /workspace/.daiops/skills/active/report/scripts/gen.py > /workspace/output/report.md',
    'bash /workspace/.daiops/skills/active/browse/bin/run.sh 2>&1 | tee /tmp/log.txt',
    'echo "- user prefers short skills summaries" >> /workspace/.daiops/MEMORY.md',
    'grep -rn "touch" /workspace/.daiops/skills/active/',
    'mkdir -p /workspace/output && cat /workspace/.daiops/instructions/active/a.md',
    'cat /workspace/.integrations.env',
    'node /workspace/.daiops/skills/active/x/scripts/a.js --install',
    'ls .daiops/ ; ls knowledge/skills-notes',
    'cat .daiops/skills-registry.json > /tmp/r.json',
    'python3 /workspace/.daiops/skills/active/x/run.py 2>/dev/null > out.md',
  ]) {
    it(command, () => {
      assert.equal(bashWritesProtectedPath(command), false)
      const d = decide(command)
      assert.notEqual(d.reason, 'protected-path')
    })
  }
})

describe('보호 경로가 쓰기 목적지면 막는다', () => {
  for (const command of [
    'echo hi > .daiops/instructions/core.md',
    'echo hi >> /workspace/.daiops/instructions/core.md',
    'cp -r /workspace/.daiops/skills/candidates/x /workspace/.daiops/skills/active/x',
    'cd /workspace/.daiops && mv skills/candidates/x skills/active/x',
    'cd /workspace/.daiops/skills && cp -r candidates/x active/',
    'mv /workspace/.daiops/skills/active/x /tmp/x',
    'rm -rf /workspace/.daiops/skills/active/x',
    'sed -i "s/a/b/" /workspace/schema/persona.yaml',
    'echo KEY=1 | tee -a /workspace/.integrations.env',
    'cat x.md > /workspace/.daiops/persona_overrides.yaml',
    'cp a.md /workspace/.daiops/skills',
    'ln -s /tmp/evil /workspace/.daiops/skills/active/evil',
    'touch .daiops/instructions/new.md',
    'tar -xzf bundle.tgz -C /workspace/.daiops/skills/active',
    'cp -t /workspace/.daiops/skills/active x',
  ]) {
    it(command, () => {
      assert.equal(bashWritesProtectedPath(command), true)
      assert.deepEqual([decide(command).kind, decide(command).reason], ['deny', 'protected-path'])
      assert.equal(decide(command, true).kind, 'plan_request')
    })
  }
})

describe('Write 는 종전대로 목적지를 본다', () => {
  for (const [fp, blocked] of [
    ['/workspace/.daiops/MEMORY.md', false],
    ['.daiops/skills/active/x/SKILL.md', true],
    ['/workspace/.daiops/skills/_versions/x/1.md', true],
    ['/workspace/.daiops/instructions/candidates/a.md', true],
    ['/workspace/output/a.md', false],
  ]) {
    it(`${fp} → ${blocked ? '차단' : '통과'}`, () => {
      const d = evaluatePolicy(full, 'Write', { file_path: fp, content: 'x' }, false)
      assert.equal(d.reason === 'protected-path', blocked)
    })
  }
})
