import { describe, it, expect } from 'vitest'
import { createPepperhornClient } from './client.js'
import { parseShareCode } from './shares.js'
import { memoryTokenStore } from './token-store.js'
import { memoryOtpFlow } from './otp-flow.js'
import { TOKEN, json, stubFetch } from '../../test/stub-fetch.js'
import type { StubHandler } from '../../test/stub-fetch.js'

const FUTURE = '2099-01-01T00:00:00.000Z'
const CODE = 'AbCdEfGhJk'
const share = { code: CODE, appSlug: 'tickle-me-ivories', kind: 'scene', payload: { v: 2 }, owner: { handle: 'ana' }, visibility: 'link_view', isOwner: false, canEdit: false, canFork: true, viewCount: 3, createdAt: FUTURE }

function client(routes: Record<string, StubHandler | StubHandler[]>, token = true) {
  const stub = stubFetch(routes)
  const tokens = memoryTokenStore()
  if (token) tokens.set(TOKEN, FUTURE)
  const c = createPepperhornClient({ appSlug: 'tickle-me-ivories', baseUrl: 'https://apps.test', fetch: stub.fetch, tokenStore: tokens, otpFlowStore: memoryOtpFlow() })
  return { c, stub, tokens }
}

describe('parseShareCode', () => {
  it.each([
    ['/s/AbCdEfGhJk', CODE], ['/s/AbCdEfGhJk/', CODE], ['/s/short', null], ['/s/AbCdEfGhJk1', null],
    ['/x/AbCdEfGhJk', null], ['/s/AbCdEf-hJk', null],
  ])('%s -> %s', (p, want) => { expect(parseShareCode(p)).toBe(want) })
  it('takes a custom pattern (chordee keeps /c/<code>)', () => {
    expect(parseShareCode('/c/AbCdEfGhJk', /^\/c\/([A-Za-z0-9]{10})$/)).toBe(CODE)
  })
})

describe('SharesClient', () => {
  it('createAnonymous works signed out and returns the revoke key', async () => {
    const { c, stub } = client({ 'POST /ph/v1/shares': () => json(200, { ok: true, code: CODE, url: 'https://ivories.test/s/' + CODE, shortUrl: null, revokeKey: 'k'.repeat(43) }) }, false)
    await expect(c.shares.createAnonymous({ kind: 'look', payload: { v: 1 } })).resolves.toMatchObject({ code: CODE, revokeKey: 'k'.repeat(43) })
    expect(stub.calls[0]).toMatchObject({ auth: null, body: { appSlug: 'tickle-me-ivories', kind: 'look', payload: { v: 1 } } })
  })

  it('a stale token on createAnonymous is dropped and the share still goes through', async () => {
    const { c, stub, tokens } = client({ 'POST /ph/v1/shares': (x) => (x.auth ? json(401, { ok: false, error: 'unauthorized' }) : json(200, { ok: true, code: CODE, url: 'u', shortUrl: null, revokeKey: 'k' })) })
    await expect(c.shares.createAnonymous({ kind: 'look', payload: {} })).resolves.toMatchObject({ code: CODE })
    expect(stub.calls).toHaveLength(2)
    expect(tokens.get()).toBeNull()
    expect(c.auth.getSnapshot().status).toBe('signed-out')
  })

  it('createFromSave needs a session and never sends a payload', async () => {
    const signedOut = client({}, false)
    await expect(signedOut.c.shares.createFromSave({ kind: 'scene', externalId: 'e1', visibility: 'link_view' })).rejects.toMatchObject({ code: 'unauthorized' })
    expect(signedOut.stub.calls).toHaveLength(0)
    const { c, stub } = client({ 'POST /ph/v1/shares': () => json(200, { ok: true, code: CODE, url: 'u', shortUrl: 'https://phrn.link/Ab12345' }) })
    await expect(c.shares.createFromSave({ kind: 'scene', externalId: 'e1', visibility: 'public' })).resolves.toEqual({ code: CODE, url: 'u', shortUrl: 'https://phrn.link/Ab12345' })
    expect(stub.calls[0]!.body).toEqual({ appSlug: 'tickle-me-ivories', kind: 'scene', externalId: 'e1', visibility: 'public' })
  })

  it('resolve: a malformed code is null without a request; 404 is null; otherwise the share', async () => {
    const { c, stub } = client({
      [`GET /ph/v1/shares/${CODE}`]: [() => json(200, { ok: true, share }), () => json(404, { ok: false, error: 'not_found' })],
    })
    await expect(c.shares.resolve('../../etc')).resolves.toBeNull()
    expect(stub.calls).toHaveLength(0)
    await expect(c.shares.resolve(CODE)).resolves.toMatchObject({ code: CODE, owner: { handle: 'ana' }, canFork: true })
    await expect(c.shares.resolve(CODE)).resolves.toBeNull()
  })

  it('update, fork and revoke hit the right routes', async () => {
    const T0 = '2026-10-13T00:00:00.000Z'
    const save = { id: 'r9', appSlug: 'tickle-me-ivories', kind: 'scene', externalId: 'f1', name: 'Copy', payload: {}, visibility: 'private', forkedFrom: CODE, createdAt: T0, updatedAt: T0 }
    const { c, stub } = client({
      [`PATCH /ph/v1/shares/${CODE}`]: () => json(200, { ok: true }),
      [`POST /ph/v1/shares/${CODE}/fork`]: () => json(200, { ok: true, save }),
      [`DELETE /ph/v1/shares/${CODE}`]: () => json(200, { ok: true }),
    })
    await c.shares.update(CODE, { v: 2 })
    await expect(c.shares.fork(CODE, { externalId: 'f1', name: 'Copy' })).resolves.toMatchObject({ forkedFrom: CODE })
    await c.shares.revoke(CODE, 'secret-key')
    expect(stub.calls[0]!.body).toEqual({ appSlug: 'tickle-me-ivories', payload: { v: 2 } })
    expect(stub.calls[1]!.body).toEqual({ appSlug: 'tickle-me-ivories', externalId: 'f1', name: 'Copy' })
    expect(stub.calls[2]).toMatchObject({ query: { appSlug: 'tickle-me-ivories' }, body: { revokeKey: 'secret-key' } })
  })

  it('revoke without a key needs a session', async () => {
    const { c } = client({}, false)
    await expect(c.shares.revoke(CODE)).rejects.toMatchObject({ code: 'unauthorized' })
  })
})
