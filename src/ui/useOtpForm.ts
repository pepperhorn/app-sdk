import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PhError, isPhError } from '../core/errors.js'
import type { AuthUser } from '../core/types.js'
import { usePh } from '../react/PhProvider.js'

export interface OtpFormOptions { codeLength: number; onDone(user: AuthUser): void; cooldownSec?: number }
export interface OtpFormState {
  step: 'email' | 'code' | 'done'
  codeLength: number
  email: string
  setEmail(v: string): void
  digits: string[]
  setDigit(index: number, value: string): void
  submitEmail(): Promise<void>
  submitCode(): Promise<void>
  resend(): Promise<void>
  back(): void
  resendInSec: number
  busy: boolean
  error: PhError | null
}

const blank = (n: number) => Array<string>(n).fill('')

/** The email -> code -> done step machine (spec §3.2). A pending code from before a reload resumes on the code step. */
export function useOtpForm(o: OtpFormOptions): OtpFormState {
  const { auth } = usePh()
  const snap = useSyncExternalStore(auth.subscribe, auth.getSnapshot, auth.getSnapshot)
  const pending = snap.status === 'signed-out' ? snap.pending : null
  const [step, setStep] = useState<OtpFormState['step']>(pending ? 'code' : 'email')
  const [email, setEmail] = useState(pending?.email ?? '')
  const [digits, setDigits] = useState(() => blank(o.codeLength))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PhError | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const submitting = useRef(false)
  const onDone = useRef(o.onDone)
  useEffect(() => { onDone.current = o.onDone })

  const cooldownMs = (o.cooldownSec ?? 60) * 1000
  const resendInSec = pending ? Math.max(0, Math.ceil((pending.codeSentAt + cooldownMs - nowMs) / 1000)) : 0
  const cooling = resendInSec > 0
  useEffect(() => {
    if (!cooling) return
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [cooling])

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(isPhError(e) ? e : new PhError('server'))
    } finally {
      setBusy(false)
    }
  }, [])

  const submitEmail = useCallback(() => run(async () => {
    await auth.requestCode(email)
    setDigits(blank(o.codeLength))
    setNowMs(Date.now())
    setStep('code')
  }), [auth, email, o.codeLength, run])

  const verify = useCallback((code: string) => {
    if (submitting.current) return Promise.resolve()
    submitting.current = true
    return run(async () => {
      try {
        const user = await auth.verifyCode(email, code)
        setStep('done')
        onDone.current(user)
      } catch (e) {
        setDigits(blank(o.codeLength))
        throw e
      }
    }).finally(() => { submitting.current = false })
  }, [auth, email, o.codeLength, run])

  const setDigit = useCallback((index: number, value: string) => {
    const clean = value.replace(/\D/g, '')
    setDigits((prev) => {
      const next = [...prev]
      if (clean.length === 0) next[index] = ''
      for (let i = 0; i < clean.length && index + i < next.length; i++) next[index + i] = clean[i]!
      return next
    })
  }, [])

  const full = digits.every((d) => d !== '')
  useEffect(() => {
    if (step === 'code' && full) void verify(digits.join(''))
    // Fires on the transition to "every digit filled"; a failed verify clears them.
  }, [full, step])

  const resend = useCallback(() => run(async () => {
    if (resendInSec > 0) return
    await auth.requestCode(email)
    setNowMs(Date.now())
  }), [auth, email, resendInSec, run])

  const back = useCallback(() => {
    setStep('email')
    setError(null)
    setDigits(blank(o.codeLength))
  }, [o.codeLength])

  return {
    step, codeLength: o.codeLength, email, setEmail, digits, setDigit,
    submitEmail, submitCode: () => verify(digits.join('')), resend, back,
    resendInSec, busy, error,
  }
}
