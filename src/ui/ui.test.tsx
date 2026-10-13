// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
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

afterEach(() => { cleanup(); vi.useRealTimers() })

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

describe('OtpDigits keyboard, autofill and form steps', () => {
  async function mount() {
    const { wrapper: Wrapper } = setup()
    let form: OtpFormState | null = null
    render(<Wrapper><Form onState={(s) => { form = s }} /></Wrapper>)
    await act(async () => { form!.setEmail('ana@example.test') })
    await act(() => form!.submitEmail())
    return { get form() { return form! }, inputs: screen.getAllByRole('textbox') as HTMLInputElement[] }
  }

  it('exposes one-time-code autocomplete and numeric inputmode', async () => {
    const { inputs } = await mount()
    expect(inputs[0]!.getAttribute('autocomplete')).toBe('one-time-code')
    expect(inputs.every((i) => i.getAttribute('inputmode') === 'numeric')).toBe(true)
  })

  it('typing a digit advances focus; Backspace on an empty box moves back', async () => {
    const { inputs } = await mount()
    inputs[0]!.focus()
    fireEvent.change(inputs[0]!, { target: { value: '5' } })
    expect(document.activeElement).toBe(inputs[1])
    fireEvent.keyDown(inputs[1]!, { key: 'Backspace' })
    expect(document.activeElement).toBe(inputs[0])
  })

  it('ArrowLeft and ArrowRight move focus', async () => {
    const { inputs } = await mount()
    inputs[3]!.focus()
    fireEvent.keyDown(inputs[3]!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(inputs[2])
    fireEvent.keyDown(inputs[2]!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(inputs[3])
  })

  it('a full code autofilled into digit 0 spreads and signs in', async () => {
    const m = await mount()
    fireEvent.change(m.inputs[0]!, { target: { value: '12345678' } })
    await waitFor(() => expect(m.form.step).toBe('done'))
  })

  it('a full-length paste into a non-first box spreads from index 0', async () => {
    const m = await mount()
    fireEvent.paste(m.inputs[4]!, { clipboardData: { getData: () => '12345678' } })
    await waitFor(() => expect(m.form.step).toBe('done'))
  })

  it('focus stays on the inputs after invalid_code (readOnly while busy, not disabled)', async () => {
    const m = await mount()
    m.inputs[7]!.focus()
    fireEvent.paste(m.inputs[0]!, { clipboardData: { getData: () => '00000000' } })
    await waitFor(() => expect(m.form.error?.code).toBe('invalid_code'))
    expect(m.inputs.every((i) => !i.disabled)).toBe(true)
  })
})

describe('useOtpForm steps', () => {
  it('back returns to email and clears digits', async () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useOtpForm({ codeLength: 8, onDone: () => {} }), { wrapper })
    act(() => result.current.setEmail('ana@example.test'))
    await act(() => result.current.submitEmail())
    act(() => result.current.setDigit(0, '12'))
    act(() => result.current.back())
    expect(result.current.step).toBe('email')
    expect(result.current.digits).toEqual(Array(8).fill(''))
  })

  it('resend is blocked during cooldown, then restarts it and clears digits', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const { wrapper, client } = setup()
    const spy = vi.spyOn(client.auth, 'requestCode')
    const { result } = renderHook(() => useOtpForm({ codeLength: 8, onDone: () => {}, cooldownSec: 60 }), { wrapper })
    act(() => result.current.setEmail('ana@example.test'))
    await act(() => result.current.submitEmail())
    await act(() => result.current.resend())
    expect(spy).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(61_000) })
    act(() => result.current.setDigit(0, '12'))
    await act(() => result.current.resend())
    expect(spy).toHaveBeenCalledTimes(2)
    expect(result.current.resendInSec).toBe(60)
    expect(result.current.digits).toEqual(Array(8).fill(''))
  })

  it('resumes on the code step from a pending code', async () => {
    const { wrapper, client } = setup()
    await client.auth.requestCode('ana@example.test')
    const { result } = renderHook(() => useOtpForm({ codeLength: 8, onDone: () => {} }), { wrapper })
    expect(result.current.step).toBe('code')
    expect(result.current.email).toBe('ana@example.test')
  })

  it('an onDone exception is not reported as a server error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { wrapper } = setup()
    const { result } = renderHook(() => useOtpForm({ codeLength: 8, onDone: () => { throw new Error('boom') } }), { wrapper })
    act(() => result.current.setEmail('ana@example.test'))
    await act(() => result.current.submitEmail())
    act(() => result.current.setDigit(0, '12345678'))
    await waitFor(() => expect(result.current.step).toBe('done'))
    expect(result.current.error).toBeNull()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
