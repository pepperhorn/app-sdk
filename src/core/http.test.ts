import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod/v4'
import { createHttp } from './http.js'
import { memoryTokenStore } from './token-store.js'
import { TOKEN, json, stubFetch } from '../../test/stub-fetch.js'

const Ok = z.object({ ok: z.literal(true) })
const FUTURE = '2099-01-01T00:00:00.000Z'

function setup(routes: Parameters<typeof stubFetch>[0], withToken = true) {
  const stub = stubFetch(routes)
  const tokens = memoryTokenStore()
  if (withToken) tokens.set(TOKEN, FUTURE)
  const onUnauthorized = vi.fn()
  const http = createHttp({ baseUrl: 'https://apps.test/', fetch: stub.fetch, tokens, onUnauthorized })
  return { http, stub, tokens, onUnauthorized }
}

describe('createHttp', () => {
  it('sends JSON with the bearer and a query string, and parses the response', async () => {
    const { http, stub } = setup({ 'POST /ph/v1/saves': () => json(200, { ok: true, extra: 1 }) })
    await expect(http({ method: 'POST', path: '/ph/v1/saves', query: { appSlug: 'a', skip: undefined }, body: { x: 1 }, auth: 'required' }, Ok))
      .resolves.toEqual({ ok: true })
    expect(stub.calls[0]).toMatchObject({ path: '/ph/v1/saves', query: { appSlug: 'a' }, auth: `Bearer ${TOKEN}`, body: { x: 1 } })
  })

  it('never sends the token on auth "none"', async () => {
    const { http, stub } = setup({ 'POST /ph/v1/enroll': () => json(200, { ok: true }) })
    await http({ method: 'POST', path: '/ph/v1/enroll', body: {}, auth: 'none' }, Ok)
    expect(stub.calls[0]!.auth).toBeNull()
  })

  it('maps a rejected fetch to network', async () => {
    const { http } = setup({ 'GET /x': () => { throw new TypeError('Failed to fetch') } })
    await expect(http({ method: 'GET', path: '/x', auth: 'none' }, Ok)).rejects.toMatchObject({ code: 'network' })
  })

  it('maps a 2xx body that fails the schema to server', async () => {
    const { http } = setup({ 'GET /x': () => json(200, { nope: true }) })
    await expect(http({ method: 'GET', path: '/x', auth: 'none' }, Ok)).rejects.toMatchObject({ code: 'server' })
  })

  it('a 401 on a request that carried the token clears it and reports it', async () => {
    const { http, tokens, onUnauthorized } = setup({ 'GET /ph/v1/me': () => json(401, { ok: false, error: 'unauthorized' }) })
    await expect(http({ method: 'GET', path: '/ph/v1/me', auth: 'required' }, Ok)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(tokens.get()).toBeNull()
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('optional auth retries once without a stale token (gateway carry: 401, never a silent fallback)', async () => {
    const { http, stub, tokens } = setup({
      'GET /ph/v1/shares/AbCdEfGhJk': (c) => (c.auth ? json(401, { ok: false, error: 'unauthorized' }) : json(200, { ok: true })),
    })
    await expect(http({ method: 'GET', path: '/ph/v1/shares/AbCdEfGhJk', auth: 'optional' }, Ok)).resolves.toEqual({ ok: true })
    expect(stub.calls.map((c) => c.auth)).toEqual([`Bearer ${TOKEN}`, null])
    expect(tokens.get()).toBeNull()
  })

  it('required auth without a token fails before any request', async () => {
    const { http, stub, onUnauthorized } = setup({}, false)
    await expect(http({ method: 'GET', path: '/ph/v1/me', auth: 'required' }, Ok)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(stub.calls).toHaveLength(0)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('a 429 keeps the token (session 429 is retry, never sign-out)', async () => {
    const { http, tokens, onUnauthorized } = setup({ 'GET /otp-auth/session': () => json(429, { errors: [] }, { 'Retry-After': '3' }) })
    await expect(http({ method: 'GET', path: '/otp-auth/session', auth: 'required' }, Ok)).rejects.toMatchObject({ code: 'rate_limited', retryAfterSec: 3 })
    expect(tokens.get()).toBe(TOKEN)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('keeps a base URL path prefix', async () => {
    const stub = stubFetch({ 'GET /prefix/ph/v1/me': () => json(200, { ok: true }) })
    const http = createHttp({ baseUrl: 'https://apps.test/prefix', fetch: stub.fetch, tokens: memoryTokenStore(), onUnauthorized: () => {} })
    await http({ method: 'GET', path: '/ph/v1/me', auth: 'none' }, Ok)
    expect(stub.calls[0]!.path).toBe('/prefix/ph/v1/me')
  })
})
