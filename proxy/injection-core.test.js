import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PLACEHOLDER_PREFIX,
  generatePlaceholder,
  buildInjectionMap,
  isHostAllowed,
  substituteInText,
  substituteHeaders,
  detectBlockedSecrets,
} from './injection-core.js'

describe('generatePlaceholder', () => {
  it('dai_phantom_ 접두사 + 64 hex', () => {
    const p = generatePlaceholder()
    assert.ok(p.startsWith(PLACEHOLDER_PREFIX))
    assert.match(p.slice(PLACEHOLDER_PREFIX.length), /^[0-9a-f]{64}$/)
  })
  it('매번 고유', () => {
    assert.notEqual(generatePlaceholder(), generatePlaceholder())
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
