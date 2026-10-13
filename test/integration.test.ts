import { describe, it, expect } from 'vitest'
import { createPepperhornClient, memoryOtpFlow, memoryTokenStore } from '../src/index.js'
import { createFakeGateway } from '../src/testing/index.js'

const APP = 'tickle-me-ivories'

function setup() {
  const gw = createFakeGateway({ appSlug: APP, shareOrigin: 'https://ivories.test', fixedCode: '12345678' })
  const make = () => createPepperhornClient({ appSlug: APP, baseUrl: 'https://apps.test', fetch: gw.fetch, tokenStore: memoryTokenStore(), otpFlowStore: memoryOtpFlow() })
  return { gw, make }
}

async function signIn(c: ReturnType<ReturnType<typeof setup>['make']>, email: string) {
  await c.auth.requestCode(email)
  return c.auth.verifyCode(email, '12345678')
}

describe('SDK against the fake gateway', () => {
  it('signs in, saves, shares from a save, and the owner can make it private', async () => {
    const { make } = setup()
    const owner = make()
    const user = await signIn(owner, 'ana@example.test')
    expect(user.handle).toMatch(/^player-\d+$/)
    expect(JSON.stringify(user)).not.toMatch(/ph_uid/i)

    const saved = await owner.saves.upsert({ kind: 'scene', externalId: 'e1', name: 'One', payload: { n: 1 } })
    await expect(owner.saves.upsert({ kind: 'scene', externalId: 'e1', name: 'One', payload: { n: 2 }, ifUpdatedAt: '2000-01-01T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'conflict' })
    await owner.saves.upsert({ kind: 'scene', externalId: 'e1', name: 'One', payload: { n: 2 }, ifUpdatedAt: saved.updatedAt })
    expect((await owner.saves.list({ kind: 'scene' })).items.map((i) => i.externalId)).toEqual(['e1'])

    const created = await owner.shares.createFromSave({ kind: 'scene', externalId: 'e1', visibility: 'link_view' })
    expect(created.url).toBe(`https://ivories.test/s/${created.code}`)
    const guest = make()
    await expect(guest.shares.resolve(created.code)).resolves.toMatchObject({ payload: { n: 2 }, owner: { handle: user.handle }, isOwner: false, canFork: false })

    await owner.saves.setVisibility('scene', 'e1', 'private')
    await expect(guest.shares.resolve(created.code)).resolves.toBeNull()
  })

  it('an anonymous share is revoked with its key', async () => {
    const { make } = setup()
    const anon = make()
    const s = await anon.shares.createAnonymous({ kind: 'look', payload: { v: 1 } })
    expect(s.revokeKey).toBeTruthy()
    await expect(anon.shares.revoke(s.code, 'wrong')).rejects.toMatchObject({ code: 'forbidden' })
    await anon.shares.revoke(s.code, s.revokeKey)
    await expect(anon.shares.resolve(s.code)).resolves.toBeNull()
  })

  it('forks into a private save of the forker, and lists devices', async () => {
    const { make } = setup()
    const owner = make()
    await signIn(owner, 'ana@example.test')
    await owner.saves.upsert({ kind: 'scene', externalId: 'e1', name: 'One', payload: { n: 1 } })
    const { code } = await owner.shares.createFromSave({ kind: 'scene', externalId: 'e1', visibility: 'link_view' })
    const other = make()
    await signIn(other, 'bob@example.test')
    await expect(other.shares.fork(code, { externalId: 'f1', name: 'Copy' })).resolves.toMatchObject({ visibility: 'private', forkedFrom: code })
    await expect(owner.shares.fork(code, { externalId: 'f2', name: 'Mine' })).rejects.toMatchObject({ code: 'forbidden' })

    const second = make()
    await signIn(second, 'ana@example.test')
    const devices = await owner.auth.devices()
    expect(devices).toHaveLength(2)
    await owner.auth.revokeDevice(devices.find((d) => !d.current)!.id)
    await expect(second.auth.restore()).resolves.toMatchObject({ status: 'signed-out' })
  })

  it('failNext injects one error response', async () => {
    const { gw, make } = setup()
    const c = make()
    gw.failNext('POST /ph/v1/enroll', 429, { ok: false, error: 'rate_limited', retryAfterSec: 30 })
    await expect(c.auth.requestCode('ana@example.test')).rejects.toMatchObject({ code: 'rate_limited', retryAfterSec: 30 })
    await expect(c.auth.requestCode('ana@example.test')).resolves.toBeUndefined()
  })

  it('applies a kind validator and the size cap', async () => {
    const gw = createFakeGateway({
      appSlug: APP, fixedCode: '12345678',
      kinds: { scene: { maxBytes: 64, validate: (p, ctx) => (!ctx.signedIn && (p as { midi?: boolean }).midi ? { ok: false, code: 'upload_requires_sign_in', detail: 'midi_upload' } : { ok: true }) } },
    })
    const c = createPepperhornClient({ appSlug: APP, baseUrl: 'https://apps.test', fetch: gw.fetch, tokenStore: memoryTokenStore(), otpFlowStore: memoryOtpFlow() })
    await expect(c.shares.createAnonymous({ kind: 'scene', payload: { midi: true } })).rejects.toMatchObject({ code: 'upload_requires_sign_in' })
    await expect(c.shares.createAnonymous({ kind: 'scene', payload: { pad: 'x'.repeat(100) } })).rejects.toMatchObject({ code: 'too_large' })
    await expect(c.shares.createAnonymous({ kind: 'look', payload: {} })).rejects.toMatchObject({ code: 'invalid' })
  })
})
