// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createPepperhornClient, memoryOtpFlow, memoryTokenStore } from '../index.js'
import { createFakeGateway } from '../testing/index.js'
import { PhProvider } from '../react/index.js'
import { OtpDigits, useOtpForm } from './index.js'
import type { OtpFormState } from './index.js'

function setup() {
  const gw = createFakeGateway({ appSlug: 'tickle-me-ivories', fixedCode: '12345678' })
  const client = createPepperhornClient({ appSlug: 'tickle-me-ivories', baseUrl: 'https://apps.test', fetch: gw.fetch, tokenStore: memoryTokenStore(), otpFlowStore: memoryOtpFlow() })
  const wrapper = ({ children }: { children: ReactNode }) => <PhProvider client={client}>{children}</PhProvider>
  return { client, wrapper }
}

afterEach(() => { vi.useRealTimers() })

describe('useOtpForm', () => {
  it('email -> code -> done, auto-submitting when a pasted code fills every digit', async () => {
    const { wrapper } = setup()
    const onDone = vi.fn()
    const { result } = renderHook(() => useOtpForm({ codeLength: 8, onDone }), { wrapper })
    act(() => result.current.setEmail('ana@example.test'))
    await act(() => result.current.submitEmail())
    expect(result.current.step).toBe('code')
    act(() => result.current.setDigit(0, '1234 5678'))
    await waitFor(() => expect(result.current.step).toBe('done'))
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ email: 'ana@example.test' }))
  })

  it('a wrong code reports invalid_code and clears the digits', async () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useOtpForm({ codeLength: 8, onDone: () => {} }), { wrapper })
    act(() => result.current.setEmail('ana@example.test'))
    await act(() => result.current.submitEmail())
    act(() => result.current.setDigit(0, '00000000'))
    await waitFor(() => expect(result.current.error?.code).toBe('invalid_code'))
    expect(result.current.digits).toEqual(Array(8).fill(''))
    expect(result.current.step).toBe('code')
  })

  it('holds resend for the cooldown', async () => {
    // Fake the interval and the clock before the code is sent, so the cooldown ticker runs on them.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const { wrapper } = setup()
    const { result } = renderHook(() => useOtpForm({ codeLength: 8, onDone: () => {}, cooldownSec: 60 }), { wrapper })
    act(() => result.current.setEmail('ana@example.test'))
    await act(() => result.current.submitEmail())
    expect(result.current.resendInSec).toBe(60)
    await act(async () => { vi.advanceTimersByTime(61_000) })
    expect(result.current.resendInSec).toBe(0)
  })
})

function Form(p: { onState(s: OtpFormState): void }) {
  const form = useOtpForm({ codeLength: 8, onDone: () => {} })
  p.onState(form)
  return <OtpDigits form={form} className="my-otp" inputClassName="my-digit" />
}

describe('OtpDigits', () => {
  it('renders the class hooks and spreads a paste across the inputs', async () => {
    const { wrapper: Wrapper } = setup()
    let form: OtpFormState | null = null
    render(<Wrapper><Form onState={(s) => { form = s }} /></Wrapper>)
    await act(async () => { form!.setEmail('ana@example.test') })
    await act(() => form!.submitEmail())
    const inputs = screen.getAllByRole('textbox')
    expect(inputs).toHaveLength(8)
    expect(inputs[0]!.className).toBe('ph-otp-digit my-digit')
    expect(inputs[0]!.closest('.ph-otp-form.my-otp')).not.toBeNull()
    fireEvent.paste(inputs[2]!, { clipboardData: { getData: () => '987' } })
    expect(form!.digits.slice(0, 6)).toEqual(['', '', '9', '8', '7', ''])
  })
})
