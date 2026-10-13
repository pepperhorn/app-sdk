// Wire-level checks that the fake answers like the real gateway
// (ph-apps-extensions endpoints/ph/src/routes/*, directus-otp-auth routes.js),
// so tests built on it predict production.
import { describe, it, expect, vi } from 'vitest'
import { createFakeGateway } from '../src/testing/index.js'

const APP = 'test-app'
const BASE = 'https://apps.test'

function client(gw = createFakeGateway({ fixedCode: '12345678' })) {
  let token: string | null = null
  const call = async (method: string, path: string, body?: unknown, auth: string | null = token) => {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (auth) headers.Authorization = `Bearer ${auth}`
    const res = await gw.fetch(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers }
  }
  const signIn = async (email: string) => {
    await call('POST', '/ph/v1/enroll', { appSlug: APP, email })
    await call('POST', '/otp-auth/code', { appSlug: APP, email })
    const v = await call('POST', '/otp-auth/verify', { appSlug: APP, email, code: gw.lastCode(email), transport: 'bearer' })
    token = v.body.token as string
    return token
  }
  return { gw, call, signIn, setToken: (t: string | null) => { token = t } }
}

describe('fake gateway wire fidelity', () => {
  it('otp-auth answers a uniform {ok:false}; the gateway answers {ok:false,error,detail?}', async () => {
    const { call } = client()
    expect(await call('POST', '/otp-auth/verify', { appSlug: APP, email: 'a@x.test', code: '00000000' })).toMatchObject({ status: 401, body: { ok: false } })
    expect((await call('POST', '/otp-auth/verify', { appSlug: APP, email: 'a@x.test', code: '00000000' })).body).toEqual({ ok: false })
    expect((await call('GET', `/ph/v1/me?appSlug=${APP}`)).body).toEqual({ ok: false, error: 'unauthorized' })
    expect((await call('GET', '/ph/v1/me?appSlug=nope')).body).toEqual({ ok: false, error: 'invalid', detail: 'unknown_app' })
  })

  it('a code is only mailed to an enrolled address, and only for the right app', async () => {
    const { gw, call } = client()
    expect((await call('POST', '/otp-auth/code', { appSlug: APP, email: 'a@x.test' })).body).toEqual({ ok: true })
    expect(gw.lastCode('a@x.test')).toBeNull()
    await call('POST', '/ph/v1/enroll', { appSlug: APP, email: ' A@X.test ' })
    await call('POST', '/otp-auth/code', { appSlug: 'other', email: 'a@x.test' })
    expect(gw.lastCode('a@x.test')).toBeNull()
    await call('POST', '/otp-auth/code', { appSlug: APP, email: 'a@x.test' })
    expect(gw.lastCode('a@x.test')).toBe('12345678')
  })

  it('enroll and public ignore a stale Authorization header; optional-auth routes 401 on it', async () => {
    const { call } = client()
    const stale = '0f8fad5b-d9cb-469f-a165-70867728950e.abcdefghijklmnopqrstuvwx'
    expect((await call('POST', '/ph/v1/enroll', { appSlug: APP, email: 'a@x.test' }, stale)).status).toBe(200)
    expect((await call('GET', `/ph/v1/public?appSlug=${APP}&kind=scene`, undefined, stale)).status).toBe(200)
    expect((await call('GET', `/ph/v1/shares/ABCDEFGHJK?appSlug=${APP}`, undefined, stale)).status).toBe(401)
    expect((await call('POST', '/ph/v1/shares', { appSlug: APP, kind: 'look', payload: {} }, stale)).status).toBe(401)
  })

  it('/me and session responses never carry ph_uid; firstName validation matches the gateway', async () => {
    const { call, signIn } = client()
    await signIn('a@x.test')
    const me = await call('GET', `/ph/v1/me?appSlug=${APP}`)
    expect(Object.keys(me.body.user).sort()).toEqual(['email', 'firstName', 'handle', 'id', 'lastName'])
    expect(JSON.stringify(me.body)).not.toMatch(/ph_uid/i)
    expect((await call('GET', `/otp-auth/session?appSlug=${APP}`)).body).toMatchObject({ ok: true, principal: { type: 'app_user' }, appSlug: APP })
    expect((await call('PATCH', '/ph/v1/me', { appSlug: APP, firstName: 42 })).body).toEqual({ ok: false, error: 'invalid', detail: 'firstName' })
    expect((await call('PATCH', '/ph/v1/me', { appSlug: APP, firstName: ' Ana ' })).body.user.firstName).toBe('Ana')
    expect((await call('PATCH', '/ph/v1/me', { appSlug: APP, firstName: '' })).body.user.firstName).toBeNull()
  })

  it('lists saves newest first with a keyset cursor; a foreign cursor is 400 invalid/cursor', async () => {
    let t = 1_000
    const { call, signIn } = client(createFakeGateway({ fixedCode: '12345678', now: () => t }))
    await signIn('a@x.test')
    for (const id of ['a', 'b', 'c']) {
      t += 10
      await call('POST', '/ph/v1/saves', { appSlug: APP, kind: 'scene', externalId: id, name: id, payload: { id } })
    }
    const p1 = await call('GET', `/ph/v1/saves?appSlug=${APP}&limit=2`)
    expect(p1.body.items.map((i: { externalId: string }) => i.externalId)).toEqual(['c', 'b'])
    expect(p1.body.items[0]).toMatchObject({ bytes: JSON.stringify({ id: 'c' }).length })
    expect(p1.body.items[0]).not.toHaveProperty('payload')
    const p2 = await call('GET', `/ph/v1/saves?appSlug=${APP}&limit=2&cursor=${p1.body.next}`)
    expect(p2.body).toMatchObject({ ok: true, next: null })
    expect(p2.body.items.map((i: { externalId: string }) => i.externalId)).toEqual(['a'])
    expect((await call('GET', `/ph/v1/saves?appSlug=${APP}&cursor=!!`)).body).toEqual({ ok: false, error: 'invalid', detail: 'cursor' })
    expect((await call('GET', `/ph/v1/saves?appSlug=${APP}&limit=0`)).body).toEqual({ ok: false, error: 'invalid', detail: 'limit' })
  })

  it('ifUpdatedAt is compared at millisecond precision, and a malformed one is 400', async () => {
    const { call, signIn } = client()
    await signIn('a@x.test')
    const s = (await call('POST', '/ph/v1/saves', { appSlug: APP, kind: 'scene', externalId: 'e', name: 'n', payload: 1 })).body.save
    const sameInstant = new Date(s.updatedAt).toISOString().replace('Z', '+00:00')
    expect((await call('POST', '/ph/v1/saves', { appSlug: APP, kind: 'scene', externalId: 'e', name: 'n', payload: 2, ifUpdatedAt: sameInstant })).status).toBe(200)
    expect((await call('POST', '/ph/v1/saves', { appSlug: APP, kind: 'scene', externalId: 'e', name: 'n', payload: 3, ifUpdatedAt: 'yesterday' })).body)
      .toEqual({ ok: false, error: 'invalid', detail: 'ifUpdatedAt' })
    expect((await call('POST', '/ph/v1/saves', { appSlug: APP, kind: 'scene', externalId: 'new', name: 'n', payload: 1, ifUpdatedAt: s.updatedAt })).body)
      .toEqual({ ok: false, error: 'conflict' })
  })

  it('an empty PATCH of a save does not move updatedAt; sharing a save does not either', async () => {
    let t = 5_000
    const { call, signIn } = client(createFakeGateway({ fixedCode: '12345678', now: () => t }))
    await signIn('a@x.test')
    const s = (await call('POST', '/ph/v1/saves', { appSlug: APP, kind: 'scene', externalId: 'e', name: 'n', payload: 1 })).body.save
    t += 100
    expect((await call('PATCH', '/ph/v1/saves/scene/e', { appSlug: APP })).body.save.updatedAt).toBe(s.updatedAt)
    const sh = await call('POST', '/ph/v1/shares', { appSlug: APP, kind: 'scene', externalId: 'e', visibility: 'link_view' })
    expect(sh.body).toEqual({ ok: true, code: expect.stringMatching(/^[A-Za-z0-9]{10}$/), url: `https://app.test/s/${sh.body.code}`, shortUrl: null })
    expect((await call('GET', `/ph/v1/saves/scene/e?appSlug=${APP}`)).body.save).toMatchObject({ updatedAt: s.updatedAt, visibility: 'link_view' })
    // Re-sharing reuses the active code.
    expect((await call('POST', '/ph/v1/shares', { appSlug: APP, kind: 'scene', externalId: 'e', visibility: 'public' })).body.code).toBe(sh.body.code)
  })

  it('resolve reports the view count from before this view, and never counts the owner', async () => {
    const { call, signIn } = client()
    await signIn('a@x.test')
    await call('POST', '/ph/v1/saves', { appSlug: APP, kind: 'scene', externalId: 'e', name: 'n', payload: 1 })
    const { code } = (await call('POST', '/ph/v1/shares', { appSlug: APP, kind: 'scene', externalId: 'e', visibility: 'link_view' })).body
    expect((await call('GET', `/ph/v1/shares/${code}?appSlug=${APP}`)).body.share).toMatchObject({ isOwner: true, viewCount: 0 })
    expect((await call('GET', `/ph/v1/shares/${code}?appSlug=${APP}`, undefined, null)).body.share).toMatchObject({ isOwner: false, viewCount: 0, owner: { handle: expect.any(String) } })
    expect((await call('GET', `/ph/v1/shares/${code}?appSlug=${APP}`, undefined, null)).body.share).toMatchObject({ viewCount: 1 })
  })

  it('an anonymous share made while signed in belongs to its creator but shows no owner', async () => {
    const { call, signIn } = client()
    await signIn('a@x.test')
    const created = (await call('POST', '/ph/v1/shares', { appSlug: APP, kind: 'look', payload: { v: 1 } })).body
    expect(Object.keys(created).sort()).toEqual(['code', 'ok', 'revokeKey', 'shortUrl', 'url'])
    expect((await call('GET', `/ph/v1/shares/${created.code}?appSlug=${APP}`)).body.share).toMatchObject({ owner: null, isOwner: true, canEdit: true, canFork: false })
    expect((await call('PATCH', `/ph/v1/shares/${created.code}`, { appSlug: APP, payload: { v: 2 } })).body).toEqual({ ok: true })
    expect((await call('DELETE', `/ph/v1/shares/${created.code}?appSlug=${APP}`, {})).body).toEqual({ ok: true })
    // Revoking twice is idempotent for whoever may revoke.
    expect((await call('DELETE', `/ph/v1/shares/${created.code}?appSlug=${APP}`, {})).status).toBe(200)
  })

  it('share revoke: no key and no session is 401; a non-string key is 400; a malformed code is 404', async () => {
    const { call } = client()
    const created = (await call('POST', '/ph/v1/shares', { appSlug: APP, kind: 'look', payload: {} })).body
    expect((await call('DELETE', `/ph/v1/shares/${created.code}?appSlug=${APP}`, {})).body).toEqual({ ok: false, error: 'unauthorized' })
    expect((await call('DELETE', `/ph/v1/shares/${created.code}?appSlug=${APP}`, { revokeKey: 7 })).body).toEqual({ ok: false, error: 'invalid', detail: 'revokeKey' })
    expect((await call('DELETE', `/ph/v1/shares/short?appSlug=${APP}`, { revokeKey: 'x' })).body).toEqual({ ok: false, error: 'not_found' })
  })

  it('deleting a save revokes its shares; a deleted user cannot be resolved as an owner', async () => {
    const { call, signIn } = client()
    await signIn('a@x.test')
    await call('POST', '/ph/v1/saves', { appSlug: APP, kind: 'scene', externalId: 'e', name: 'n', payload: 1 })
    const { code } = (await call('POST', '/ph/v1/shares', { appSlug: APP, kind: 'scene', externalId: 'e', visibility: 'public' })).body
    expect((await call('GET', `/ph/v1/public?appSlug=${APP}&kind=scene`)).body.items).toEqual([
      { externalId: 'e', name: 'n', kind: 'scene', ownerHandle: expect.any(String), updatedAt: expect.any(String), shareCode: code },
    ])
    await call('DELETE', `/ph/v1/saves/scene/e?appSlug=${APP}`)
    expect((await call('GET', `/ph/v1/shares/${code}?appSlug=${APP}`)).status).toBe(404)
    expect((await call('GET', `/ph/v1/public?appSlug=${APP}&kind=scene`)).body).toEqual({ ok: true, items: [], next: null })
  })

  it('failNext sends its headers (Retry-After) and is consumed once', async () => {
    const { gw, call } = client()
    gw.failNext('GET /ph/v1/public', 429, { ok: false, error: 'rate_limited', retryAfterSec: 5 }, { 'Retry-After': '5' })
    const r = await call('GET', `/ph/v1/public?appSlug=${APP}&kind=scene`)
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).toBe('5')
    expect((await call('GET', `/ph/v1/public?appSlug=${APP}&kind=scene`)).status).toBe(200)
  })

  it('seedSave enrolls the owner and stores under userId|kind|externalId', () => {
    const { gw } = client()
    const s = gw.seedSave('A@x.test', { kind: 'scene', externalId: 'e', name: 'n', payload: 1, visibility: 'public' })
    const u = gw.users.get('a@x.test')!
    expect(gw.saves.get(`${u.id}|scene|e`)).toBe(s)
    expect(u.handle).toMatch(/^player-\d+$/)
  })

  it('reads appSlug by method like production: query for GET/DELETE, body for POST/PATCH', async () => {
    const { call, signIn } = client()
    await signIn('a@x.test')
    // wrong place -> the gateway sees no app
    expect((await call('GET', '/ph/v1/me')).body).toEqual({ ok: false, error: 'invalid', detail: 'unknown_app' })
    expect((await call('PATCH', `/ph/v1/me?appSlug=${APP}`, {})).body).toEqual({ ok: false, error: 'invalid', detail: 'unknown_app' })
    expect((await call('POST', `/ph/v1/saves?appSlug=${APP}`, { kind: 'scene' })).body).toEqual({ ok: false, error: 'invalid', detail: 'unknown_app' })
    expect((await call('DELETE', '/ph/v1/shares/AbCdEfGhJk', { appSlug: APP })).body).toEqual({ ok: false, error: 'invalid', detail: 'unknown_app' })
    // right place
    expect((await call('GET', `/ph/v1/me?appSlug=${APP}`)).status).toBe(200)
    expect((await call('PATCH', '/ph/v1/me', { appSlug: APP })).status).toBe(200)
  })

  it('non-Fail exceptions: logged and 500 by default; rethrown with debug', async () => {
    const boom = { maxBytes: 1024, validate: () => { throw new Error('kaboom') } }
    const body = { appSlug: APP, kind: 'scene', externalId: 'e', name: 'n', payload: {} }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const a = client(createFakeGateway({ appSlug: APP, kinds: { scene: boom }, fixedCode: '12345678' }))
      await a.signIn('a@x.test')
      const r = await a.call('POST', '/ph/v1/saves', body)
      expect(r).toMatchObject({ status: 500, body: { ok: false, error: 'server' } })
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('fake gateway'), expect.objectContaining({ message: 'kaboom' }))
      const d = client(createFakeGateway({ appSlug: APP, kinds: { scene: boom }, fixedCode: '12345678', debug: true }))
      await d.signIn('a@x.test')
      await expect(d.call('POST', '/ph/v1/saves', body)).rejects.toThrow('kaboom')
    } finally {
      spy.mockRestore()
    }
  })
})
