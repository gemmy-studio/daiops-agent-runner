import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PLACEHOLDER_PREFIX,
  generatePlaceholder,
  buildInjectionMap,
  isHostAllowed,
  substituteInText,
  substituteInUrl,
  substituteInBody,
  substituteHeaders,
  detectBlockedSecrets,
  maskPlaceholders,
  detectSecretBlockNotice,
} from './injection-core.js'

describe('generatePlaceholder', () => {
  it('dai_phantom_ 접두사 + 키 이름 + 16 hex', () => {
    const p = generatePlaceholder('STRIPE_API_KEY')
    assert.ok(p.startsWith(PLACEHOLDER_PREFIX))
    assert.match(p.slice(PLACEHOLDER_PREFIX.length), /^STRIPE_API_KEY_[0-9a-f]{16}$/)
  })
  it('사람이 보고 어떤 키인지 알 수 있다(라벨 목적)', () => {
    assert.ok(generatePlaceholder('GH_TOKEN').includes('GH_TOKEN'))
  })
  it('키 이름이 같아도 매번 고유', () => {
    assert.notEqual(generatePlaceholder('K'), generatePlaceholder('K'))
  })
  it('안전하지 않은 문자는 정규화하고 길이를 제한한다', () => {
    const p = generatePlaceholder('a b/c;d')
    assert.ok(p.includes('a_b_c_d'))
    const long = generatePlaceholder('X'.repeat(200))
    assert.ok(long.length < 80)
  })
  it('키가 비어도 유효한 placeholder를 만든다', () => {
    const p = generatePlaceholder('')
    assert.match(p, new RegExp(`^${PLACEHOLDER_PREFIX}[0-9a-f]{16}$`))
  })
})

describe('buildInjectionMap', () => {
  it('key별 placeholder 생성 + injectionMap 구성', () => {
    const { placeholderByKey, injectionMap } = buildInjectionMap([
      { key: 'STRIPE_API_KEY', realValue: 'sk_live_real', allowedHosts: ['api.stripe.com'] },
    ])
    const ph = placeholderByKey.get('STRIPE_API_KEY')
    assert.ok(ph.startsWith(PLACEHOLDER_PREFIX))
    assert.deepEqual(injectionMap.get(ph), {
      key: 'STRIPE_API_KEY',
      realValue: 'sk_live_real',
      allowedHosts: ['api.stripe.com'],
    })
  })
  it('key/realValue 누락 항목은 스킵', () => {
    const { injectionMap } = buildInjectionMap([
      { key: '', realValue: 'x', allowedHosts: [] },
      { key: 'K', realValue: '', allowedHosts: [] },
      { key: 'OK', realValue: 'v', allowedHosts: ['h'] },
    ])
    assert.equal(injectionMap.size, 1)
  })
  it('allowedHosts 누락 시 빈 배열(fail-closed)', () => {
    const { placeholderByKey, injectionMap } = buildInjectionMap([
      { key: 'K', realValue: 'v' },
    ])
    assert.deepEqual(injectionMap.get(placeholderByKey.get('K')).allowedHosts, [])
  })
  it('비배열 입력은 빈 맵', () => {
    assert.equal(buildInjectionMap(null).injectionMap.size, 0)
  })
  it('injectionMap은 placeholder가 긴 것부터 담긴다(부분문자열 파괴 방지 불변식)', () => {
    const { injectionMap } = buildInjectionMap([
      { key: 'A', realValue: 'v1' },
      { key: 'A_LONGER_NAME', realValue: 'v2' },
      { key: 'AB', realValue: 'v3' },
    ])
    const lengths = [...injectionMap.keys()].map((p) => p.length)
    assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a))
  })
  it('한쪽이 다른 쪽의 부분문자열이어도 긴 것이 먼저 치환된다', () => {
    // 무작위 꼬리 때문에 실제로는 거의 불가능하지만, 불변식이 지켜지는지를 직접 확인한다.
    const injectionMap = new Map([
      ['ph_LONG', { key: 'LONG', realValue: 'REAL_LONG', allowedHosts: ['h.com'] }],
      ['ph', { key: 'SHORT', realValue: 'REAL_SHORT', allowedHosts: ['h.com'] }],
    ])
    const r = substituteInText('x ph_LONG y', 'h.com', injectionMap)
    assert.equal(r.text, 'x REAL_LONG y')
  })
})

describe('isHostAllowed', () => {
  it('정확 일치', () => {
    assert.ok(isHostAllowed('api.stripe.com', ['api.stripe.com']))
    assert.ok(!isHostAllowed('evil.com', ['api.stripe.com']))
  })
  it('포트/대소문자/후행점 정규화', () => {
    assert.ok(isHostAllowed('API.Stripe.com:443', ['api.stripe.com']))
    assert.ok(isHostAllowed('api.stripe.com.', ['api.stripe.com']))
  })
  it('서브도메인 와일드카드 *.example.com', () => {
    assert.ok(isHostAllowed('a.example.com', ['*.example.com']))
    assert.ok(isHostAllowed('a.b.example.com', ['*.example.com']))
    assert.ok(!isHostAllowed('example.com', ['*.example.com'])) // 부모 자체 제외
    assert.ok(!isHostAllowed('example.com.evil.com', ['*.example.com']))
  })
  it('fail-closed — 빈/누락 allowedHosts는 항상 false', () => {
    assert.ok(!isHostAllowed('api.stripe.com', []))
    assert.ok(!isHostAllowed('api.stripe.com', undefined))
  })
})

describe('substituteInText', () => {
  const { placeholderByKey, injectionMap } = buildInjectionMap([
    { key: 'STRIPE_API_KEY', realValue: 'sk_live_REAL', allowedHosts: ['api.stripe.com'] },
  ])
  const ph = placeholderByKey.get('STRIPE_API_KEY')

  it('허용 호스트 → 진짜 값으로 치환', () => {
    const r = substituteInText(`Bearer ${ph}`, 'api.stripe.com', injectionMap)
    assert.equal(r.text, 'Bearer sk_live_REAL')
    assert.deepEqual(r.substituted, ['STRIPE_API_KEY'])
  })
  it('비허용 호스트 → placeholder 유지(치환 안 함)', () => {
    const r = substituteInText(`Bearer ${ph}`, 'evil.com', injectionMap)
    assert.equal(r.text, `Bearer ${ph}`)
    assert.deepEqual(r.substituted, [])
  })
  it('placeholder 없는 텍스트는 그대로', () => {
    const r = substituteInText('no secrets here', 'api.stripe.com', injectionMap)
    assert.equal(r.text, 'no secrets here')
  })
  it('한 텍스트에 같은 placeholder 여러 번', () => {
    const r = substituteInText(`${ph} and ${ph}`, 'api.stripe.com', injectionMap)
    assert.equal(r.text, 'sk_live_REAL and sk_live_REAL')
  })
})

describe('substituteHeaders', () => {
  const { placeholderByKey, injectionMap } = buildInjectionMap([
    { key: 'GH_TOKEN', realValue: 'ghp_REAL', allowedHosts: ['api.github.com'] },
    { key: 'X_KEY', realValue: 'xkey_REAL', allowedHosts: ['*.example.com'] },
  ])
  const gh = placeholderByKey.get('GH_TOKEN')
  const xk = placeholderByKey.get('X_KEY')

  it('허용 호스트의 헤더만 치환', () => {
    const r = substituteHeaders(
      { Authorization: `token ${gh}`, 'X-Api-Key': xk },
      'api.github.com',
      injectionMap,
    )
    assert.equal(r.headers.Authorization, 'token ghp_REAL')
    assert.equal(r.headers['X-Api-Key'], xk) // example.com 전용이라 미치환
    assert.deepEqual(r.substituted, ['GH_TOKEN'])
  })
  it('원본 헤더 불변', () => {
    const orig = { Authorization: `token ${gh}` }
    substituteHeaders(orig, 'api.github.com', injectionMap)
    assert.equal(orig.Authorization, `token ${gh}`)
  })
})

describe('maskPlaceholders', () => {
  const { placeholderByKey } = buildInjectionMap([
    { key: 'STRIPE_API_KEY', realValue: 'sk_live_REAL', allowedHosts: ['api.stripe.com'] },
  ])
  const ph = placeholderByKey.get('STRIPE_API_KEY')

  it('placeholder를 키 이름이 보이는 라벨로 바꾼다', () => {
    assert.equal(maskPlaceholders(`KEY=${ph}`), 'KEY=<placeholder:STRIPE_API_KEY>')
  })
  it('원문 placeholder가 결과에 남지 않는다', () => {
    assert.ok(!maskPlaceholders(`x ${ph} y`).includes(ph))
  })
  it('한 텍스트에 여러 개', () => {
    const out = maskPlaceholders(`${ph} / ${ph}`)
    assert.equal(out, '<placeholder:STRIPE_API_KEY> / <placeholder:STRIPE_API_KEY>')
  })
  it('placeholder가 없으면 원문 그대로', () => {
    assert.equal(maskPlaceholders('nothing to mask'), 'nothing to mask')
  })
  it('키 라벨 없는(구형) placeholder도 처리', () => {
    assert.equal(maskPlaceholders(`${PLACEHOLDER_PREFIX}${'a'.repeat(16)}`), '<placeholder>')
  })
  it('문자열이 아니어도 안전', () => {
    assert.equal(maskPlaceholders(null), '')
    assert.equal(maskPlaceholders(undefined), '')
  })
  it('연속 호출이 같은 결과 — 전역 정규식 lastIndex 오염 없음', () => {
    const first = maskPlaceholders(`a ${ph} b`)
    const second = maskPlaceholders(`a ${ph} b`)
    assert.equal(first, second)
  })
})

/**
 * 차단은 자식 프로세스(curl 등)에 403 JSON으로 돌아가므로 러너 본체는 그 사건을 도구 출력에서만
 * 볼 수 있다. 여기서 건져 올려야 "어떤 키가 어느 호스트에서 막혔는지"를 구조화해 보여줄 수 있다.
 */
describe('detectSecretBlockNotice', () => {
  const body = JSON.stringify({
    error: 'secret_host_not_allowed',
    secret: 'STRIPE_API_KEY',
    secrets: ['STRIPE_API_KEY'],
    host: 'evil.example.com',
    message: '허용되지 않았어요',
  })

  it('curl 출력에 섞인 403 JSON에서 키·호스트를 뽑는다', () => {
    const r = detectSecretBlockNotice(`HTTP/1.1 403\n\n${body}\n`)
    assert.deepEqual(r, { secrets: ['STRIPE_API_KEY'], host: 'evil.example.com' })
  })

  it('secrets 배열이 없고 secret 단일 필드만 있어도 처리', () => {
    const single = JSON.stringify({ error: 'secret_host_not_allowed', secret: 'K', host: 'h.com' })
    assert.deepEqual(detectSecretBlockNotice(single), { secrets: ['K'], host: 'h.com' })
  })

  it('무관한 출력·깨진 JSON·필드 누락은 null', () => {
    assert.equal(detectSecretBlockNotice('just some output'), null)
    assert.equal(detectSecretBlockNotice('{"error":"secret_host_not_allowed", oops'), null)
    assert.equal(detectSecretBlockNotice('{"error":"secret_host_not_allowed","host":"h.com"}'), null)
    assert.equal(detectSecretBlockNotice(null), null)
  })
})

describe('detectBlockedSecrets', () => {
  const { placeholderByKey, injectionMap } = buildInjectionMap([
    { key: 'GH_TOKEN', realValue: 'ghp_REAL', allowedHosts: ['api.github.com'] },
    { key: 'NO_HOSTS', realValue: 'secret2', allowedHosts: [] },
  ])
  const gh = placeholderByKey.get('GH_TOKEN')
  const nh = placeholderByKey.get('NO_HOSTS')

  it('placeholder 존재 + 미허용 호스트 → 차단 목록에 포함', () => {
    const blocked = detectBlockedSecrets([`Bearer ${gh}`], 'evil.example.com', injectionMap)
    assert.deepEqual(blocked.map((b) => b.key), ['GH_TOKEN'])
  })

  it('placeholder 존재 + 허용 호스트 → 차단 아님', () => {
    const blocked = detectBlockedSecrets([`Bearer ${gh}`], 'api.github.com', injectionMap)
    assert.deepEqual(blocked, [])
  })

  it('allowedHosts 비면(fail-closed) 어느 호스트든 차단', () => {
    const blocked = detectBlockedSecrets([`x ${nh}`], 'api.github.com', injectionMap)
    assert.deepEqual(blocked.map((b) => b.key), ['NO_HOSTS'])
  })

  it('placeholder 없는 요청 → 차단 없음', () => {
    const blocked = detectBlockedSecrets(['Bearer normal-token', '/path'], 'evil.example.com', injectionMap)
    assert.deepEqual(blocked, [])
  })

  it('여러 문자열(헤더·path·body) 중 하나라도 있으면 탐지', () => {
    const blocked = detectBlockedSecrets(['Authorization: x', '/api?k=' + gh, ''], 'evil.example.com', injectionMap)
    assert.deepEqual(blocked.map((b) => b.key), ['GH_TOKEN'])
  })

  it('빈 injectionMap → 차단 없음', () => {
    assert.deepEqual(detectBlockedSecrets([`Bearer ${gh}`], 'evil.example.com', new Map()), [])
  })

  it('값(realValue)은 반환에 포함하지 않음', () => {
    const blocked = detectBlockedSecrets([`Bearer ${gh}`], 'evil.example.com', injectionMap)
    assert.ok(!JSON.stringify(blocked).includes('ghp_REAL'))
  })
})

// ── 표면별 인코딩 (2026-08-20) ─────────────────────────────────────────────
// 회귀 방지 대상: 값에 `+ / =` 가 든 키를 URL 쿼리에 실었을 때 raw 치환이라 받는 쪽에서
// 키가 깨졌다(공공데이터포털 403 "등록되지 않은 서비스키"). 헤더로 쓰는 키는 멀쩡해
// 원인이 오래 가려졌다 — 그래서 **표면마다** 검증한다.

/** base64 서비스키를 본뜬 값 — URL에서 구분자로 읽히는 문자를 전부 포함한다. */
const B64ish = 'abc+def/ghi=='

function mapWith(realValue, allowedHosts = ['apis.data.go.kr']) {
  const { placeholderByKey, injectionMap } = buildInjectionMap([
    { key: 'DATA_GO_KR_SERVICE_KEY', realValue, allowedHosts },
  ])
  return { ph: placeholderByKey.get('DATA_GO_KR_SERVICE_KEY'), injectionMap }
}

describe('substituteInUrl', () => {
  it('쿼리 값은 percent-encode 된다 (+ / = 가 살아 나가면 안 된다)', () => {
    const { ph, injectionMap } = mapWith(B64ish)
    const r = substituteInUrl(`/api?serviceKey=${ph}&n=1`, 'apis.data.go.kr', injectionMap)
    assert.equal(r.text, '/api?serviceKey=abc%2Bdef%2Fghi%3D%3D&n=1')
    assert.deepEqual(r.substituted, ['DATA_GO_KR_SERVICE_KEY'])
    // 받는 쪽이 디코딩하면 원래 값으로 돌아온다 — 이것이 통과 조건이다.
    assert.equal(new URLSearchParams(r.text.split('?')[1]).get('serviceKey'), B64ish)
  })

  it('우리가 만들지 않은 다른 파라미터의 인코딩을 보존한다 (재직렬화 금지)', () => {
    const { ph, injectionMap } = mapWith(B64ish)
    const r = substituteInUrl(`/api?sig=A%20B&k=${ph}`, 'apis.data.go.kr', injectionMap)
    assert.ok(r.text.includes('sig=A%20B'), '기존 %20 이 + 로 바뀌면 서명이 깨진다')
  })

  it('경로에 들어간 값도 인코딩한다 (/ 가 살면 경로가 갈라진다)', () => {
    const { ph, injectionMap } = mapWith(B64ish)
    const r = substituteInUrl(`/v1/${ph}/info`, 'apis.data.go.kr', injectionMap)
    assert.equal(r.text, '/v1/abc%2Bdef%2Fghi%3D%3D/info')
  })

  it('허용되지 않은 호스트면 placeholder를 그대로 둔다 (fail-closed)', () => {
    const { ph, injectionMap } = mapWith(B64ish, ['apis.data.go.kr'])
    const r = substituteInUrl(`/api?k=${ph}`, 'evil.example.com', injectionMap)
    assert.equal(r.text, `/api?k=${ph}`)
    assert.deepEqual(r.substituted, [])
  })

  it('쿼리가 없는 경로도 그대로 다룬다', () => {
    const { injectionMap } = mapWith(B64ish)
    assert.equal(substituteInUrl('/plain', 'apis.data.go.kr', injectionMap).text, '/plain')
  })
})

describe('substituteInBody', () => {
  it('JSON 바디는 문자열 이스케이프 — 따옴표가 구조를 깨뜨리지 않는다', () => {
    const { ph, injectionMap } = mapWith('a"b\\c')
    const r = substituteInBody(`{"k":"${ph}"}`, 'application/json', 'apis.data.go.kr', injectionMap)
    assert.deepEqual(JSON.parse(r.text), { k: 'a"b\\c' })
  })

  it('form 바디는 percent-encode — & 가 필드 경계를 깨뜨리지 않는다', () => {
    const { ph, injectionMap } = mapWith('a&b=c')
    const r = substituteInBody(`k=${ph}&n=1`, 'application/x-www-form-urlencoded', 'apis.data.go.kr', injectionMap)
    assert.equal(new URLSearchParams(r.text).get('k'), 'a&b=c')
    assert.equal(new URLSearchParams(r.text).get('n'), '1')
  })

  it('content-type 매개변수(charset)가 붙어도 판정한다', () => {
    const { ph, injectionMap } = mapWith('a"b')
    const r = substituteInBody(`{"k":"${ph}"}`, 'application/json; charset=utf-8', 'apis.data.go.kr', injectionMap)
    assert.deepEqual(JSON.parse(r.text), { k: 'a"b' })
  })

  it('multipart 는 건드리지 않는다 (경계 문자열 훼손 방지)', () => {
    const { ph, injectionMap } = mapWith(B64ish)
    const body = `--X\r\nContent-Disposition: form-data; name="k"\r\n\r\n${ph}\r\n--X--`
    const r = substituteInBody(body, 'multipart/form-data; boundary=X', 'apis.data.go.kr', injectionMap)
    assert.equal(r.skipped, true)
    assert.equal(r.text, body)
  })

  it('그 밖의 content-type 은 raw 치환 (종전 동작 유지)', () => {
    const { ph, injectionMap } = mapWith(B64ish)
    const r = substituteInBody(ph, 'text/plain', 'apis.data.go.kr', injectionMap)
    assert.equal(r.text, B64ish)
  })
})

describe('substituteHeaders — raw 유지와 CRLF 가드', () => {
  it('헤더 값은 raw 로 넣는다 (인코딩하면 Basic 인증이 깨진다)', () => {
    const { ph, injectionMap } = mapWith(B64ish, ['example.com'])
    const r = substituteHeaders({ authorization: `Basic ${ph}` }, 'example.com', injectionMap)
    assert.equal(r.headers.authorization, `Basic ${B64ish}`)
    assert.deepEqual(r.substituted, ['DATA_GO_KR_SERVICE_KEY'])
  })

  it('값에 CR/LF 가 있으면 치환하지 않는다 (헤더 인젝션 가드)', () => {
    const { ph, injectionMap } = mapWith('good\r\nX-Injected: evil', ['example.com'])
    const r = substituteHeaders({ authorization: `Basic ${ph}` }, 'example.com', injectionMap)
    assert.equal(r.headers.authorization, `Basic ${ph}`, 'placeholder 가 그대로 남아야 한다')
    assert.deepEqual(r.substituted, [])
    assert.deepEqual(r.rejected, ['DATA_GO_KR_SERVICE_KEY'])
  })
})
