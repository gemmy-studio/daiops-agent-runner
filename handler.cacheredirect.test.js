import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { correctCacheRedirect } from './handler.js'

const CACHE = '/workspace/knowledge/sources/uploads/.cache'

describe('correctCacheRedirect', () => {
  it('LLM이 한자 hallucinate + 공백/괄호 제거한 cache 경로를 입력 basename으로 정정', () => {
    const orig = 'da'
    const inputName = `제1편_댐및저수지현황_1.일반 현황('24년)_제공.hwpx`
    const inputPath = `/workspace/.attachments/${inputName}`
    // LLM이 잘못 만든 출력 — '반→般', 괄호·공백·따옴표 정리
    const hallucinated = `${CACHE}/제1편_댐및저수지현황_1.일般현황_24년_제공.hwpx.md`
    const command =
      `node /workspace/.tools/document-hwp/cli.js readHwpx "${inputPath}" > "${hallucinated}"`

    const out = correctCacheRedirect(command)

    assert.ok(out.includes(`> "${CACHE}/${inputName}.md"`),
      `corrected output should contain exact basename:\n${out}`)
    assert.ok(!out.includes('일般'), 'hallucinated 한자가 사라져야 함')
  })

  it('readDocx — 한국어 파일명 단순 케이스', () => {
    const inputPath = '/workspace/.attachments/사업계획서.docx'
    const command =
      `node /workspace/.tools/document-core/cli.js readDocx "${inputPath}" > "${CACHE}/사업계획서.docx.md"`
    const out = correctCacheRedirect(command)
    assert.equal(out, command, '이미 일치하면 변경 없음')
  })

  it('readPdf — 변형된 cache basename도 정정', () => {
    const inputPath = '/workspace/.attachments/report (final).pdf'
    const command =
      `node /workspace/.tools/document-core/cli.js readPdf "${inputPath}" > "${CACHE}/report_final.pdf.md"`
    const out = correctCacheRedirect(command)
    assert.ok(out.includes(`> "${CACHE}/report (final).pdf.md"`), out)
  })

  it('readXlsx — 작은따옴표로 묶인 입력', () => {
    const inputName = "데이터'24.xlsx"
    const inputPath = `/workspace/.attachments/${inputName}`
    const command =
      `node /workspace/.tools/document-core/cli.js readXlsx '${inputPath}' > "${CACHE}/data.xlsx.md"`
    const out = correctCacheRedirect(command)
    assert.ok(out.includes(inputName), `unquoted basename should appear: ${out}`)
  })

  it('>> append redirect도 동일 정정', () => {
    const inputPath = '/workspace/.attachments/notes.hwpx'
    const command =
      `node /workspace/.tools/document-hwp/cli.js readHwpx "${inputPath}" >> "${CACHE}/wrong.hwpx.md"`
    const out = correctCacheRedirect(command)
    assert.ok(out.includes(`>> "${CACHE}/notes.hwpx.md"`), out)
  })

  it('redirect 없는 cli.js 호출은 손대지 않음', () => {
    const command = 'node /workspace/.tools/document-hwp/cli.js readHwpx /workspace/.attachments/x.hwpx'
    assert.equal(correctCacheRedirect(command), command)
  })

  it('cache 외 경로로의 redirect는 손대지 않음', () => {
    const command =
      'node /workspace/.tools/document-hwp/cli.js readHwpx /workspace/.attachments/x.hwpx > /tmp/out.md'
    assert.equal(correctCacheRedirect(command), command)
  })

  it('cli.js 도구가 아닌 일반 명령은 손대지 않음', () => {
    const command = `ls /workspace/.attachments/ > "${CACHE}/listing.md"`
    assert.equal(correctCacheRedirect(command), command)
  })

  it('2> stderr redirect는 변환하지 않음 (cache 경로가 아니므로)', () => {
    const command =
      `node /workspace/.tools/document-hwp/cli.js readHwpx /workspace/.attachments/x.hwpx 2> /tmp/err.log`
    assert.equal(correctCacheRedirect(command), command)
  })

  it('stdout(>) 정상 + stderr(2>)가 뒤에 같이 있어도 stdout만 정정', () => {
    const inputPath = '/workspace/.attachments/data.hwpx'
    const command =
      `node /workspace/.tools/document-hwp/cli.js readHwpx "${inputPath}" > "${CACHE}/wrong.hwpx.md" 2> /tmp/err.log`
    const out = correctCacheRedirect(command)
    assert.ok(out.includes(`> "${CACHE}/data.hwpx.md"`), out)
    assert.ok(out.includes('2> /tmp/err.log'), 'stderr redirect 유지')
  })

  it('빈/비문자열 입력은 안전 통과', () => {
    assert.equal(correctCacheRedirect(''), '')
    assert.equal(correctCacheRedirect(null), null)
    assert.equal(correctCacheRedirect(undefined), undefined)
    assert.equal(correctCacheRedirect(123), 123)
  })

  it('$, `, " 가 포함된 basename도 큰따옴표 안에서 안전 이스케이프', () => {
    const inputName = 'a$b`c"d.hwpx'
    const inputPath = `/workspace/.attachments/${inputName}`
    const command =
      `node /workspace/.tools/document-hwp/cli.js readHwpx "/workspace/.attachments/a\\$b\\\`c\\"d.hwpx" > "${CACHE}/wrong.md"`
    const out = correctCacheRedirect(command)
    // 출력 토큰의 $, `, " 가 escape됐는지
    const tail = out.split(' > ')[1] ?? ''
    assert.ok(tail.startsWith('"'), `tail should start with quote: ${tail}`)
    assert.ok(tail.includes('\\$') && tail.includes('\\`') && tail.includes('\\"'),
      `shell metachars must be escaped: ${tail}`)
  })
})
