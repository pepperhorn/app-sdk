import { useRef } from 'react'
import type { OtpFormState } from './useOtpForm.js'

const cx = (...c: (string | undefined)[]) => c.filter(Boolean).join(' ')

/** Unstyled digit inputs for useOtpForm. Class hooks: .ph-otp-form (group), .ph-otp-digit (each input). */
export function OtpDigits(p: { form: OtpFormState; className?: string; inputClassName?: string; autoFocus?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const { form } = p
  const n = form.digits.length
  const focus = (i: number) => refs.current[Math.max(0, Math.min(i, n - 1))]?.focus()
  return (
    <div className={cx('ph-otp-form', p.className)} role="group" aria-label="Sign-in code">
      {form.digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el }}
          type="text"
          className={cx('ph-otp-digit', p.inputClassName)}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${i + 1} of ${n}`}
          autoFocus={p.autoFocus === true && i === 0}
          value={d}
          disabled={form.busy}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '')
            form.setDigit(i, d && v.length === 2 ? v.slice(-1) : v)
            if (v) focus(i + Math.max(1, v.length === 2 && d ? 1 : v.length))
          }}
          onPaste={(e) => {
            e.preventDefault()
            const t = e.clipboardData.getData('text')
            form.setDigit(i, t)
            focus(i + t.replace(/\D/g, '').length)
          }}
          onKeyDown={(e) => { if (e.key === 'Backspace' && !d && i > 0) focus(i - 1) }}
        />
      ))}
    </div>
  )
}
