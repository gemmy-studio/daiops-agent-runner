/**
 * Bash 명령의 쓰기 목적지 판정(tokenizeShell, writeTargetsOf, unquoteShellToken 를 거치는 bashWritesProtectedPath).
 * 트랙 G5(2026-11-25): 2단계 돌연변이에서 이 함수들의 변이가 가장 많이 살아남았다(tokenizeShell 88, writeTargetsOf 73).
 * 셸 꼴은 Claude Code 권한 매처가 이슈에서 반복해 놓친 자리(파이프, 서브셸, 히어독, 리다이렉트, bash -c)와
 * 판정 주석(handler.js 「목적지로 보는 자리」)에서 골랐다.
 *
 * `todo` 는 지금 판정이 놓치는 꼴이다. 판정 주석이 이미 「스크립트로 우회하는 것은 명령 문자열로 못 막는다」고 적어 둔
 * 한계와 같은 갈래라 고치지 않고 기록만 한다.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { bashWritesProtectedPath } from './handler.js'

const SKILL = '/workspace/.daiops/skills/active/x/SKILL.md'
const writes = (cmd, opts) => bashWritesProtectedPath(cmd, opts)

describe('쓰기 목적지: 리다이렉트', () => {
  const cases = [
    ['>', `echo hi > ${SKILL}`],
    ['>>', `echo hi >> ${SKILL}`],
    ['&>', `echo hi &> ${SKILL}`],
    ['붙여 쓴 >', `echo hi >${SKILL}`],
    ['fd 2>', `ls 2> ${SKILL}`],
    ['파이프 뒤', `cat a | grep b > ${SKILL}`],
    ['히어독', `cat <<EOF > ${SKILL}\nhi\nEOF`],
    ['서브셸 안', `(echo hi > ${SKILL})`],
    ['&& 뒤 명령', `true && echo hi > ${SKILL}`],
    ['|| 뒤 명령', `false || echo hi > ${SKILL}`],
    ['백그라운드 & 뒤', `sleep 1 & echo hi > ${SKILL}`],
    ['개행 뒤', `true\necho hi > ${SKILL}`],
    ['작은따옴표 경로', `echo hi > '${SKILL}'`],
    ['큰따옴표 경로', `echo hi > "${SKILL}"`],
    ['역슬래시로 이은 경로', `echo hi > /workspace/.daiops/skil\\ls/active/x`],
  ]
  for (const [label, cmd] of cases) {
    it(`${label}: 막는다`, () => assert.equal(writes(cmd), true))
  }

  it('2>&1 은 파일이 아니다', () => assert.equal(writes(`cat ${SKILL} 2>&1`), false))
  it('>&2 는 파일이 아니다', () => assert.equal(writes(`cat ${SKILL} >&2`), false))
  it('보호 경로를 읽어 밖으로 쓰는 것은 통과', () => assert.equal(writes(`cat ${SKILL} > /tmp/out.md`), false))
  it('큰따옴표 안 역슬래시는 다음 글자를 그대로 둔다', () => assert.equal(writes(`echo hi > "/workspace/.daiops/skills/a\\"b"`), true))
  it('따옴표 안의 > 는 리다이렉트가 아니다', () => assert.equal(writes(`echo "a > ${SKILL}"`), false))
  it('따옴표 안의 ; 는 분리자가 아니다', () => assert.equal(writes(`echo "x; rm ${SKILL}"`), false))
})

describe('쓰기 목적지: 명령 인자', () => {
  const blocked = [
    ['rm', `rm -f ${SKILL}`],
    ['touch', `touch ${SKILL}`],
    ['mkdir 디렉토리 자체', 'mkdir -p /workspace/.daiops/skills'],
    ['chmod', `chmod 000 ${SKILL}`],
    ['tee', `echo hi | tee -a ${SKILL}`],
    ['mv 옮겨 나가기', `mv ${SKILL} /tmp/x`],
    ['mv 옮겨 들이기', `mv /tmp/x ${SKILL}`],
    ['cp 마지막 인자', `cp /tmp/x ${SKILL}`],
    ['cp -t', 'cp -t /workspace/.daiops/skills/ /tmp/x'],
    ['cp --target-directory=', 'cp --target-directory=/workspace/.daiops/skills /tmp/x'],
    ['install', `install -m 644 /tmp/x ${SKILL}`],
    ['ln', `ln -sf /tmp/x ${SKILL}`],
    ['rsync', 'rsync -a /tmp/x/ /workspace/.daiops/skills/'],
    ['sed -i', `sed -i 's/a/b/' ${SKILL}`],
    ['sed -i -e', `sed -i -e 's/a/b/' ${SKILL}`],
    ['sed --in-place', `sed --in-place 's/a/b/' ${SKILL}`],
    ['perl -pi', `perl -pi -e 's/a/b/' ${SKILL}`],
    ['dd of=', `dd if=/tmp/x of=${SKILL}`],
    ['tar -x -C', 'tar -xzf a.tgz -C /workspace/.daiops/skills'],
    ['tar --extract --directory=', 'tar --extract -f a.tar --directory=/workspace/.daiops/skills'],
    ['unzip -d', 'unzip a.zip -d /workspace/.daiops/skills'],
    ['unzip -d 붙여 씀', 'unzip a.zip -d/workspace/.daiops/skills'],
    ['patch', `patch ${SKILL} fix.diff`],
    ['sudo 앞붙이', `sudo rm ${SKILL}`],
    ['env 변수 앞붙이', `FOO=1 env rm ${SKILL}`],
    ['절대경로 명령', `/bin/rm ${SKILL}`],
    ['페르소나 덮어쓰기', 'cp /tmp/p.yaml /workspace/schema/persona.yaml'],
    ['연동 키 파일', 'echo K=v >> /workspace/.integrations.env'],
  ]
  for (const [label, cmd] of blocked) {
    it(`${label}: 막는다`, () => assert.equal(writes(cmd), true))
  }

  const allowed = [
    ['cp 원본 자리', `cp ${SKILL} /tmp/x`],
    ['sed -i 없이 읽기', `sed 's/a/b/' ${SKILL}`],
    ['tar 만들기(-c)', 'tar -czf /tmp/a.tgz -C /workspace/.daiops/skills .'],
    ['cat 읽기', `cat ${SKILL}`],
    ['스킬 스크립트 실행', 'python3 /workspace/.daiops/skills/active/x/run.py > /tmp/out'],
    ['dd if= 만', `dd if=${SKILL} of=/tmp/x`],
  ]
  for (const [label, cmd] of allowed) {
    it(`${label}: 통과`, () => assert.equal(writes(cmd), false))
  }
})

describe('쓰기 목적지: 낱말 경계(돌연변이로 고름)', () => {
  const DIR = '/workspace/.daiops/skills'
  const cases = [
    ['탭으로 띄운 인자', `rm\t${SKILL}`, true],
    ['띄어쓰기 없는 ;', `true;rm ${SKILL}`, true],
    ['띄어쓰기 없는 |', `cat a|tee ${SKILL}`, true],
    ['단독 & 뒤 명령', `sleep 1 & rm ${SKILL}`, true],
    ['앞에 공백', `   rm ${SKILL}`, true],
    ['인자 사이 2>&1', `cp /tmp/x 2>&1 ${SKILL}`, true],
    ['인자 사이 >&2', `cp /tmp/x >&2 ${SKILL}`, true],
    ['숫자로 끝나는 낱말 바로 뒤 >', `rm ${DIR}/x2>/dev/null`, true],
    ['숫자로 시작하는 낱말 바로 뒤 >', `cd ${DIR} && rm 1x>/dev/null`, true],
    ['한 글자 낱말 바로 뒤 >', `cd ${DIR} && rm b>/dev/null`, true],
    ['큰따옴표 안 \\" 는 따옴표를 닫지 않는다', `echo "a\\" ; rm ${SKILL} ; \\"b"`, false],
    ['역슬래시로 막은 && 는 분리자가 아니다', `echo a \\&\\& rm ${SKILL}`, false],
  ]
  for (const [label, cmd, want] of cases) {
    it(`${label}: ${want ? '막는다' : '통과'}`, () => assert.equal(writes(cmd), want))
  }
})

describe('쓰기 목적지: 명령 목록 전부', () => {
  for (const cmd of ['rmdir', 'truncate -s 0', 'chown root', 'chgrp root', 'unlink', 'shred -u']) {
    it(`${cmd.split(' ')[0]}: 막는다`, () => assert.equal(writes(`${cmd} ${SKILL}`), true))
  }
  for (const prefix of ['nohup', 'time', 'command', 'exec', 'nice']) {
    it(`앞붙이 ${prefix}: 막는다`, () => assert.equal(writes(`${prefix} rm ${SKILL}`), true))
  }
  it('cp -t 붙여 씀', () => assert.equal(writes('cp -t/workspace/.daiops/skills /tmp/x'), true))
  it('sed -ni 묶은 글자', () => assert.equal(writes(`sed -ni 's/a/b/p' ${SKILL}`), true))
  it('sed --in-place=.bak', () => assert.equal(writes(`sed --in-place=.bak 's/a/b/' ${SKILL}`), true))
  it('sed -i --expression 띄어 씀', () => assert.equal(writes(`sed -i --expression 's/a/b/' ${SKILL}`), true))
  it('sed -i --expression= 붙여 씀', () => assert.equal(writes(`sed -i --expression='s/a/b/' ${SKILL}`), true))
  it('sed -i 의 스크립트 낱말은 목적지가 아니다', () => assert.equal(writes(`sed -i ${SKILL} /tmp/x`), false))
  it('tar -t(목록)는 풀지 않는다', () => assert.equal(writes('tar -tf a.tar -C /workspace/.daiops/skills'), false))
  it('변수 대입만 있고 명령이 없으면 통과', () => assert.equal(writes(`FOO=${SKILL}`), false))
})

describe('쓰기 목적지: 상대경로와 cd', () => {
  it('cwd 기준 상대경로', () => assert.equal(writes('rm .daiops/skills/active/x/SKILL.md'), true))
  it('cd 를 따라간다', () => assert.equal(writes('cd /workspace/.daiops && rm skills/active/x/SKILL.md'), true))
  it('cd .. 를 따라간다', () => assert.equal(writes('cd /workspace/.daiops/skills/active && rm ../../instructions/a.md'), true))
  it('인자 없는 cd 는 /workspace', () => assert.equal(writes('cd /tmp; cd; rm .integrations.env'), true))
  it('~/ 는 /workspace', () => assert.equal(writes('rm ~/.integrations.env'), true))
  it('다른 cwd 에서 같은 상대경로는 통과', () => assert.equal(writes('rm .daiops/skills/x', { cwd: '/tmp' }), false))
  it('cd 뒤 밖으로 쓰는 것은 통과', () => assert.equal(writes('cd /workspace/.daiops/skills && cat x > /tmp/y'), false))
})

describe('쓰기 목적지: 풀 수 없는 변수', () => {
  it('변수가 든 목적지에 보호 이름이 보이면 막는다', () => assert.equal(writes('rm $HOME/.daiops/skills/x'), true))
  it('명령 치환이 든 목적지에 보호 이름이 보이면 막는다', () => assert.equal(writes('echo > `pwd`/schema/persona.yaml'), true))
  it('변수가 든 목적지에 보호 이름이 없으면 통과', () => assert.equal(writes('rm $TMPDIR/x'), false))
})

describe('쓰기 목적지: 지금 놓치는 꼴(기록만)', () => {
  const todo = { todo: '명령 문자열 판정의 한계(스크립트 우회와 같은 갈래). 고치지 않고 기록' }
  it('bash -c 안의 리다이렉트', todo, () => assert.equal(writes(`bash -c "echo hi > ${SKILL}"`), true))
  it('sh -c 안의 rm', todo, () => assert.equal(writes(`sh -c 'rm ${SKILL}'`), true))
  it('xargs 로 넘긴 rm', todo, () => assert.equal(writes(`echo ${SKILL} | xargs rm`), true))
  it('find -delete', todo, () => assert.equal(writes('find /workspace/.daiops/skills -name "*.md" -delete'), true))
})
