// The in-flight OTP step (drumlet's {step, email, codeSentAt}, 10 min TTL), so
// a reload between "send code" and "enter code" lands back on the code step.
import type { PendingOtp } from './types.js'

export const OTP_FLOW_TTL_MS = 10 * 60 * 1000

export interface OtpFlowStore {
  load(): PendingOtp | null
  save(p: PendingOtp): void
  clear(): void
}

function fresh(v: unknown, now: number): v is PendingOtp {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.email === 'string' && typeof o.codeSentAt === 'number'
    && o.codeSentAt <= now && now - o.codeSentAt < OTP_FLOW_TTL_MS
}

export function memoryOtpFlow(now: () => number = Date.now): OtpFlowStore {
  let p: PendingOtp | null = null
  return {
    load() { return fresh(p, now()) ? p : (p = null) },
    save(next) { p = { email: next.email, codeSentAt: next.codeSentAt } },
    clear() { p = null },
  }
}

export function localStorageOtpFlow(key: string, now: () => number = Date.now): OtpFlowStore {
  const mem = memoryOtpFlow(now)
  const ls = (): Storage | null => {
    try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
  }
  return {
    load() {
      const s = ls()
      let raw: string | null = null
      try { raw = s ? s.getItem(key) : null } catch { raw = null }
      if (raw === null) return mem.load()
      let v: unknown = null
      try { v = JSON.parse(raw) } catch { v = null }
      if (typeof v === 'object' && v !== null && (v as { step?: unknown }).step === 'code') {
        const { email, codeSentAt } = v as { email?: unknown; codeSentAt?: unknown }
        const p = { email, codeSentAt }
        if (fresh(p, now())) return p
      }
      try { s?.removeItem(key) } catch { /* nothing more to do */ }
      return null
    },
    save(p) {
      mem.save(p)
      try { ls()?.setItem(key, JSON.stringify({ step: 'code', email: p.email, codeSentAt: p.codeSentAt })) } catch { /* memory copy stands */ }
    },
    clear() {
      mem.clear()
      try { ls()?.removeItem(key) } catch { /* nothing more to do */ }
    },
  }
}
