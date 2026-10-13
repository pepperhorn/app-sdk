import { describe, it, expect } from 'vitest'
import { PhError, codeForStatus, errorFromResponse, isPhError } from './errors.js'
import { json } from '../../test/stub-fetch.js'

describe('codeForStatus', () => {
  it.each([
    [400, 'invalid'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [409, 'conflict'],
    [413, 'too_large'], [415, 'invalid'], [429, 'rate_limited'], [500, 'server'], [502, 'unavailable'],
    [503, 'unavailable'], [504, 'unavailable'],
  ] as const)('%i -> %s', (status, code) => {
    expect(codeForStatus(status)).toBe(code)
  })
})

describe('errorFromResponse', () => {
  it('uses the gateway body code and a machine detail', async () => {
    const e = await errorFromResponse(json(403, { ok: false, error: 'upload_requires_sign_in', detail: 'midi_upload' }))
    expect(e.code).toBe('upload_requires_sign_in')
    expect(e.detail).toBe('midi_upload')
    expect(e.status).toBe(403)
  })

  it('maps otp-auth {ok:false} and Directus error chains by status, never echoing server text', async () => {
    const a = await errorFromResponse(json(401, { ok: false }))
    expect(a.code).toBe('unauthorized')
    const b = await errorFromResponse(json(400, { errors: [{ message: 'secret internals', extensions: { code: 'INVALID_PAYLOAD' } }] }))
    expect(b.code).toBe('invalid')
    expect(b.message).not.toContain('secret')
    const c = await errorFromResponse(new Response('<html>bad gateway</html>', { status: 502 }))
    expect(c.code).toBe('unavailable')
    expect(c.message).not.toContain('html')
  })

  it('reads retryAfterSec from the body, then from Retry-After', async () => {
    expect((await errorFromResponse(json(429, { ok: false, error: 'rate_limited', retryAfterSec: 12 }))).retryAfterSec).toBe(12)
    expect((await errorFromResponse(json(429, { errors: [] }, { 'Retry-After': '7' }))).retryAfterSec).toBe(7)
  })

  it('never takes "network" from a server body, and drops a non-machine detail', async () => {
    const e = await errorFromResponse(json(500, { ok: false, error: 'network', detail: 'Key (email)=(a@b) exists' }))
    expect(e.code).toBe('server')
    expect(e.detail).toBeUndefined()
  })

  it('keeps the camelCase details the gateway really sends', async () => {
    for (const d of ['externalId', 'visibility', 'ifUpdatedAt', 'revokeKey', 'firstName']) {
      expect((await errorFromResponse(json(400, { ok: false, error: 'invalid', detail: d }))).detail).toBe(d)
    }
  })

  it('gives quota and handle_taken their own messages', async () => {
    expect((await errorFromResponse(json(409, { ok: false, error: 'conflict', detail: 'quota' }))).message).toMatch(/limit of saves/)
    expect((await errorFromResponse(json(409, { ok: false, error: 'conflict', detail: 'handle_taken' }))).message).toMatch(/handle/)
  })
})

describe('isPhError', () => {
  it('matches by shape, so a second copy of the SDK still matches', () => {
    expect(isPhError(new PhError('network'))).toBe(true)
    const foreign = Object.assign(new Error('x'), { name: 'PhError', code: 'conflict' })
    expect(isPhError(foreign)).toBe(true)
    expect(isPhError(Object.assign(new Error('x'), { name: 'PhError', code: 'nope' }))).toBe(false)
  })
})
