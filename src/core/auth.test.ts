import { afterEach, describe, it, expect, vi } from 'vitest'
import { createPepperhornClient } from './client.js'
import { memoryTokenStore } from './token-store.js'
import { memoryOtpFlow } from './otp-flow.js'
import { TOKEN, json, stubFetch } from '../../test/stub-fetch.js'
import type { StubHandler } from '../../test/stub-fetch.js'

const FUTURE = '2099-01-01T00:00:00.000Z'
const USER = { id: 'u1', email: 'ana@example.test', handle: 'ana', firstName: 'Ana', lastName: null }
const ok = (b: object = {}) => json(200, { ok: true, ...b })
const session = () => ok({ principal: { type: 'app_user', id: 'u1' }, appSlug: 'tickle-me-ivories', expiresAt: FUTURE })
const me = () => ok({ user: USER })

function client(routes: Record<string, StubHandler | StubHandler[]>, o: { token?: boolean } = {}) {
  const stub = stubFetch(routes)
  const tokens = memoryTokenStore()
  if (o.token) tokens.set(TOKEN, FUTURE)
  const otp = memoryOtpFlow()
  const c = createPepperhornClient({
    appSlug: 'tickle-me-ivories', baseUrl: 'https://apps.test', fetch: stub.fetch, tokenStore: tokens,
    otpFlowStore: otp, appVersion: '1.2.3', deviceLabel: 'Test browser',
  })
  return { c, stub, tokens, otp }
}

afterEach(() => { vi.useRealTimers() })

describe('initial snapshot', () => {
  it('is signed-out without a token and unknown with one', () => {
    expect(client({}).c.auth.getSnapshot()).toEqual({ status: 'signed-out', pending: null })
    expect(client({}, { token: true }).c.auth.getSnapshot()).toEqual({ status: 'unknown' })
  })
})

describe('requestCode', () => {
  it('enrolls, then asks for a code, with a normalised email, and remembers the pending step', async () => {
    const { c, stub, otp } = client({ 'POST /ph/v1/enroll': ok, 'POST /otp-auth/code': ok })
    await c.auth.requestCode('  Ana@Example.TEST ')
    expect(stub.calls.map((x) => `${x.method} ${x.path}`)).toEqual(['POST /ph/v1/enroll', 'POST /otp-auth/code'])
    expect(stub.calls[0]!.body).toEqual({ email: 'ana@example.test', appSlug: 'tickle-me-ivories' })
    expect(stub.calls.every((x) => x.auth === null)).toBe(true)
    const snap = c.auth.getSnapshot()
    expect(snap).toMatchObject({ status: 'signed-out', pending: { email: 'ana@example.test' } })
    expect(otp.load()?.email).toBe('ana@example.test')
  })

  it('refuses a malformed email before any request', async () => {
    const { c, stub } = client({})
    await expect(c.auth.requestCode('not-an-email')).rejects.toMatchObject({ code: 'invalid' })
    expect(stub.calls).toHaveLength(0)
  })
})

describe('verifyCode', () => {
  it('stores the bearer token, reads /me with it and signs in', async () => {
    const { c, stub, tokens } = client({
      'POST /otp-auth/verify': () => ok({ token: TOKEN, expiresAt: FUTURE }),
      'GET /ph/v1/me': me,
    })
    const user = await c.auth.verifyCode('ana@example.test', ' 1234 5678 ')
    expect(user).toEqual(USER)
    expect(tokens.get()).toBe(TOKEN)
    expect(stub.calls[0]!.body).toEqual({
      email: 'ana@example.test', code: '12345678', appSlug: 'tickle-me-ivories', transport: 'bearer',
      appVersion: '1.2.3', deviceLabel: 'Test browser',
    })
    expect(stub.calls[1]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(c.auth.getSnapshot()).toEqual({ status: 'signed-in', user: USER, expiresAt: FUTURE })
  })

  it('maps a 401 to invalid_code and stores nothing', async () => {
    const { c, tokens } = client({ 'POST /otp-auth/verify': () => json(401, { ok: false }) })
    await expect(c.auth.verifyCode('ana@example.test', '00000000')).rejects.toMatchObject({ code: 'invalid_code' })
    expect(tokens.get()).toBeNull()
  })
})

describe('restore', () => {
  it('signs in from a stored token', async () => {
    const { c } = client({ 'GET /otp-auth/session': session, 'GET /ph/v1/me': me }, { token: true })
    await expect(c.auth.restore()).resolves.toMatchObject({ status: 'signed-in', user: { handle: 'ana' } })
  })

  it('signs out and clears the token only on a 401', async () => {
    const { c, tokens } = client({ 'GET /otp-auth/session': () => json(401, { ok: false }) }, { token: true })
    await expect(c.auth.restore()).resolves.toMatchObject({ status: 'signed-out' })
    expect(tokens.get()).toBeNull()
  })

  it('keeps the token through a 503 and retries with backoff (Review Focus 3)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { c, tokens, stub } = client({
      'GET /otp-auth/session': [() => json(503, { ok: false }), session],
      'GET /ph/v1/me': me,
    }, { token: true })
    await expect(c.auth.restore()).resolves.toEqual({ status: 'unknown' })
    expect(tokens.get()).toBe(TOKEN)
    await vi.advanceTimersByTimeAsync(999)
    expect(stub.calls.filter((x) => x.path === '/otp-auth/session')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(c.auth.getSnapshot().status).toBe('signed-in'))
  })

  it('honours Retry-After on a 429 and never signs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { c, tokens, stub } = client({
      'GET /otp-auth/session': [() => json(429, { errors: [] }, { 'Retry-After': '7' }), session],
      'GET /ph/v1/me': me,
    }, { token: true })
    await c.auth.restore()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(stub.calls.filter((x) => x.path === '/otp-auth/session')).toHaveLength(1)
    expect(tokens.get()).toBe(TOKEN)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(c.auth.getSnapshot().status).toBe('signed-in'))
  })

  it.each([400, 403])('stops retrying on a %i (not a transient failure) and shows signed-out (preflight Task 4)', async (status) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { c, stub } = client({ 'GET /otp-auth/session': () => json(status, { ok: false }) }, { token: true })
    await expect(c.auth.restore()).resolves.toMatchObject({ status: 'signed-out' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(stub.calls.filter((x) => x.path === '/otp-auth/session')).toHaveLength(1)
  })

  it.each([400, 403])('a %i restore clears the token so optional-auth calls go out without it', async (status) => {
    const { c, stub, tokens } = client({
      'GET /otp-auth/session': () => json(status, { ok: false }),
      'POST /ph/v1/shares': () => ok({ code: 'AbCdEfGhJk', url: 'u', shortUrl: null }),
    }, { token: true })
    await c.auth.restore()
    expect(c.auth.getSnapshot().status).toBe('signed-out')
    expect(tokens.get()).toBeNull()
    await c.shares.createAnonymous({ kind: 'look', payload: {} })
    expect(stub.calls.find((x) => x.path === '/ph/v1/shares')!.auth).toBeNull()
  })

  it('a 401 on an authenticated call keeps the pending OTP step', async () => {
    const { c, otp } = client({ 'GET /otp-auth/sessions': () => json(401, { ok: false }) }, { token: true })
    const SENT = Date.now()
    otp.save({ email: 'ana@example.test', codeSentAt: SENT })
    await expect(c.auth.devices()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(c.auth.getSnapshot()).toEqual({ status: 'signed-out', pending: { email: 'ana@example.test', codeSentAt: SENT } })
  })

  it('a failed requestCode while unknown leaves the restore retry alive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { c, stub } = client({
      'GET /otp-auth/session': [() => json(503, { ok: false }), session],
      'GET /ph/v1/me': me, 'POST /ph/v1/enroll': () => json(503, { ok: false }),
    }, { token: true })
    await c.auth.restore()
    expect(c.auth.getSnapshot().status).toBe('unknown')
    await expect(c.auth.requestCode('ana@example.test')).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(2000)
    expect(stub.calls.filter((x) => x.path === '/otp-auth/session')).toHaveLength(2)
    expect(c.auth.getSnapshot().status).toBe('signed-in')
  })

  it('requestCode while unknown cancels a late restore so it cannot sign in mid-code-entry', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { c } = client({
      'GET /otp-auth/session': async () => { await gate; return session() },
      'GET /ph/v1/me': me, 'POST /ph/v1/enroll': ok, 'POST /otp-auth/code': ok,
    }, { token: true })
    const restoring = c.auth.restore()
    await c.auth.requestCode('ana@example.test')
    release()
    await restoring
    expect(c.auth.getSnapshot()).toMatchObject({ status: 'signed-out', pending: { email: 'ana@example.test' } })
  })

  it('parses the /me envelope, not a bare user', async () => {
    const { c } = client({ 'GET /otp-auth/session': session, 'GET /ph/v1/me': () => ok(USER) }, { token: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await expect(c.auth.restore()).resolves.toEqual({ status: 'unknown' })
  })

  it('keeps the token when offline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { c, tokens } = client({ 'GET /otp-auth/session': () => { throw new TypeError('Failed to fetch') } }, { token: true })
    await expect(c.auth.restore()).resolves.toEqual({ status: 'unknown' })
    expect(tokens.get()).toBe(TOKEN)
  })
})

describe('sign out and devices', () => {
  it('signOut clears the token even when the server call fails', async () => {
    const { c, tokens } = client({ 'POST /otp-auth/logout': () => json(500, { ok: false }) }, { token: true })
    await c.auth.signOut()
    expect(tokens.get()).toBeNull()
    expect(c.auth.getSnapshot()).toEqual({ status: 'signed-out', pending: null })
  })

  it('signOutEverywhere returns the revoked count', async () => {
    const { c, tokens } = client({ 'POST /otp-auth/logout-all': () => ok({ revoked: 3 }) }, { token: true })
    await expect(c.auth.signOutEverywhere()).resolves.toBe(3)
    expect(tokens.get()).toBeNull()
  })

  const sessions = () => ok({
    sessions: [
      { id: 's1', appSlug: 'tickle-me-ivories', deviceLabel: 'Laptop', userAgent: 'UA1', ip: '10.0.0.1', lastAccessAt: FUTURE, expiresAt: FUTURE, current: true },
      { id: 's2', appSlug: 'tickle-me-ivories', deviceLabel: null, userAgent: 'UA2', ip: null, lastAccessAt: null, expiresAt: FUTURE, current: false },
    ],
  })

  it('devices maps deviceLabel to label and drops ip', async () => {
    const { c } = client({ 'GET /otp-auth/sessions': sessions }, { token: true })
    const list = await c.auth.devices()
    expect(list[0]).toEqual({ id: 's1', appSlug: 'tickle-me-ivories', label: 'Laptop', userAgent: 'UA1', lastAccessAt: FUTURE, expiresAt: FUTURE, current: true })
    expect(JSON.stringify(list)).not.toContain('10.0.0.1')
  })

  it('revoking another device keeps this one signed in; revoking this one signs out', async () => {
    const { c, tokens, stub } = client({
      'GET /otp-auth/sessions': sessions, 'DELETE /otp-auth/sessions/s2': ok, 'DELETE /otp-auth/sessions/s1': ok,
      'GET /otp-auth/session': session, 'GET /ph/v1/me': me,
    }, { token: true })
    await c.auth.restore()
    await c.auth.revokeDevice('s2')
    expect(c.auth.getSnapshot().status).toBe('signed-in')
    expect(stub.calls.find((x) => x.method === 'DELETE')?.query).toEqual({ appSlug: 'tickle-me-ivories' })
    await c.auth.revokeDevice('s1')
    expect(c.auth.getSnapshot().status).toBe('signed-out')
    expect(tokens.get()).toBeNull()
  })

  it('any 401 on an authenticated call signs out', async () => {
    const { c } = client({ 'GET /otp-auth/session': session, 'GET /ph/v1/me': me, 'GET /otp-auth/sessions': () => json(401, { ok: false }) }, { token: true })
    await c.auth.restore()
    await expect(c.auth.devices()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(c.auth.getSnapshot().status).toBe('signed-out')
  })

  it('updateProfile updates the signed-in user; handle_taken is a conflict', async () => {
    const { c } = client({
      'GET /otp-auth/session': session, 'GET /ph/v1/me': me,
      'PATCH /ph/v1/me': [() => ok({ user: { ...USER, handle: 'ana2' } }), () => json(409, { ok: false, error: 'conflict', detail: 'handle_taken' })],
    }, { token: true })
    await c.auth.restore()
    await c.auth.updateProfile({ handle: 'ana2' })
    expect(c.auth.getSnapshot()).toMatchObject({ user: { handle: 'ana2' } })
    await expect(c.auth.updateProfile({ handle: 'bob' })).rejects.toMatchObject({ code: 'conflict', detail: 'handle_taken' })
  })
})

describe('authorizedFetch', () => {
  it('adds the bearer for PepperHorn and refuses any other origin', async () => {
    const { c, stub } = client({ 'GET /ph/v1/files/f1': () => json(200, {}) }, { token: true })
    await c.auth.authorizedFetch('/ph/v1/files/f1')
    expect(stub.calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
    await expect(c.auth.authorizedFetch('https://evil.test/steal')).rejects.toMatchObject({ code: 'invalid' })
    expect(stub.calls).toHaveLength(1)
  })
})

describe('createPepperhornClient', () => {
  it('refuses a malformed app slug', () => {
    expect(() => createPepperhornClient({ appSlug: 'Bad Slug' })).toThrow(/appSlug/)
  })
})
