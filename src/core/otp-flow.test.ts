import { afterEach, describe, it, expect, vi } from 'vitest'
import { OTP_FLOW_TTL_MS, localStorageOtpFlow, memoryOtpFlow } from './otp-flow.js'

describe('otp flow persistence', () => {
  it('returns the pending step until its 10 minute TTL passes', () => {
    let t = 1_000_000
    const s = memoryOtpFlow(() => t)
    s.save({ email: 'a@b.test', codeSentAt: t })
    expect(s.load()).toEqual({ email: 'a@b.test', codeSentAt: t })
    t += OTP_FLOW_TTL_MS + 1
    expect(s.load()).toBeNull()
  })

  describe('localStorageOtpFlow', () => {
    afterEach(() => { vi.unstubAllGlobals() })
    function fakeStorage() {
      const m = new Map<string, string>()
      return {
        m,
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => { m.set(k, v) },
        removeItem: (k: string) => { m.delete(k) },
      }
    }

    it('persists drumlet-style {step, email, codeSentAt} and expires it', () => {
      const ls = fakeStorage()
      vi.stubGlobal('localStorage', ls)
      let t = 5_000_000
      const s = localStorageOtpFlow('ph.otp.x', () => t)
      s.save({ email: 'a@b.test', codeSentAt: t })
      expect(JSON.parse(ls.m.get('ph.otp.x')!)).toEqual({ step: 'code', email: 'a@b.test', codeSentAt: t })
      expect(localStorageOtpFlow('ph.otp.x', () => t).load()).toEqual({ email: 'a@b.test', codeSentAt: t })
      t += OTP_FLOW_TTL_MS
      expect(s.load()).toBeNull()
      expect(ls.m.has('ph.otp.x')).toBe(false)
    })

    it('falls back to memory when storage throws', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => { throw new Error('denied') },
        setItem: () => { throw new Error('denied') },
        removeItem: () => { throw new Error('denied') },
      })
      const s = localStorageOtpFlow('k', () => 10)
      s.save({ email: 'a@b.test', codeSentAt: 10 })
      expect(s.load()).toEqual({ email: 'a@b.test', codeSentAt: 10 })
      s.clear()
      expect(s.load()).toBeNull()
    })
  })
})
