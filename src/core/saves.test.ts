import { describe, it, expect } from 'vitest'
import { z } from 'zod/v4'
import { createPepperhornClient } from './client.js'
import { memoryTokenStore } from './token-store.js'
import { memoryOtpFlow } from './otp-flow.js'
import { TOKEN, json, stubFetch } from '../../test/stub-fetch.js'
import type { StubHandler } from '../../test/stub-fetch.js'

const FUTURE = '2099-01-01T00:00:00.000Z'
const T0 = '2026-10-13T00:00:00.000Z'
const row = (o: object = {}) => ({
  id: 'r1', appSlug: 'tickle-me-ivories', kind: 'scene', externalId: 'e1', name: 'One', payload: { a: 1 },
  visibility: 'private', forkedFrom: null, createdAt: T0, updatedAt: T0, ...o,
})

function client(routes: Record<string, StubHandler | StubHandler[]>, token = true) {
  const stub = stubFetch(routes)
  const tokens = memoryTokenStore()
  if (token) tokens.set(TOKEN, FUTURE)
  const c = createPepperhornClient({ appSlug: 'tickle-me-ivories', baseUrl: 'https://apps.test', fetch: stub.fetch, tokenStore: tokens, otpFlowStore: memoryOtpFlow() })
  return { c, stub }
}

describe('SavesClient', () => {
  it('list passes kind, cursor and limit and returns items and next', async () => {
    const { payload: _p, ...summary } = row()
    const { c, stub } = client({ 'GET /ph/v1/saves': () => json(200, { ok: true, items: [{ ...summary, bytes: 9 }], next: 'CUR2' }) })
    await expect(c.saves.list({ kind: 'scene', cursor: 'CUR1', limit: 100 })).resolves.toEqual({ items: [{ ...summary, bytes: 9 }], next: 'CUR2' })
    expect(stub.calls[0]!.query).toEqual({ appSlug: 'tickle-me-ivories', kind: 'scene', cursor: 'CUR1', limit: '100' })
  })

  it('get returns null on 404 and refuses a payload that fails the caller schema', async () => {
    const { c } = client({ 'GET /ph/v1/saves/scene/missing': () => json(404, { ok: false, error: 'not_found' }), 'GET /ph/v1/saves/scene/e1': () => json(200, { ok: true, save: row() }) })
    await expect(c.saves.get('scene', 'missing')).resolves.toBeNull()
    await expect(c.saves.get('scene', 'e1')).resolves.toMatchObject({ externalId: 'e1', payload: { a: 1 } })
    await expect(c.saves.get('scene', 'e1', z.object({ b: z.string() }))).rejects.toMatchObject({ code: 'invalid' })
  })

  it('upsert sends ifUpdatedAt and surfaces a stale write and the quota as conflicts', async () => {
    const { c, stub } = client({
      'POST /ph/v1/saves': [
        () => json(200, { ok: true, save: row() }),
        () => json(409, { ok: false, error: 'conflict' }),
        () => json(409, { ok: false, error: 'conflict', detail: 'quota' }),
      ],
    })
    await c.saves.upsert({ kind: 'scene', externalId: 'e1', name: 'One', payload: { a: 1 }, ifUpdatedAt: T0 })
    expect(stub.calls[0]!.body).toEqual({ appSlug: 'tickle-me-ivories', kind: 'scene', externalId: 'e1', name: 'One', payload: { a: 1 }, ifUpdatedAt: T0 })
    await expect(c.saves.upsert({ kind: 'scene', externalId: 'e1', name: 'One', payload: {}, ifUpdatedAt: T0 })).rejects.toMatchObject({ code: 'conflict', detail: undefined })
    await expect(c.saves.upsert({ kind: 'scene', externalId: 'e2', name: 'Two', payload: {} })).rejects.toMatchObject({ code: 'conflict', detail: 'quota' })
  })

  it('upsert sends only the known fields', async () => {
    const { c, stub } = client({ 'POST /ph/v1/saves': () => json(200, { ok: true, save: row() }) })
    await c.saves.upsert({ kind: 'scene', externalId: 'e1', name: 'One', payload: {}, id: 'x', createdAt: T0 } as never)
    expect(Object.keys(stub.calls[0]!.body as object).sort()).toEqual(['appSlug', 'externalId', 'kind', 'name', 'payload'])
  })

  it('setVisibility, remove and listPublic hit the right routes; listPublic sends no token', async () => {
    const { c, stub } = client({
      'PATCH /ph/v1/saves/scene/e1': () => json(200, { ok: true, save: row({ visibility: 'public' }) }),
      'DELETE /ph/v1/saves/scene/e1': () => json(200, { ok: true }),
      'GET /ph/v1/public': () => json(200, { ok: true, items: [], next: null }),
    })
    await c.saves.setVisibility('scene', 'e1', 'public')
    await c.saves.remove('scene', 'e1')
    await c.saves.listPublic({ kind: 'scene' })
    expect(stub.calls.map((x) => [x.method, x.path, x.auth !== null])).toEqual([
      ['PATCH', '/ph/v1/saves/scene/e1', true], ['DELETE', '/ph/v1/saves/scene/e1', true], ['GET', '/ph/v1/public', false],
    ])
    expect(stub.calls[1]!.query).toEqual({ appSlug: 'tickle-me-ivories' })
  })
})
