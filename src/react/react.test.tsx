// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createPepperhornClient, memoryOtpFlow, memoryTokenStore } from '../index.js'
import type { PhClient } from '../index.js'
import { createFakeGateway } from '../testing/index.js'
import { PhProvider, useAuth, useSaves, useShareFromUrl } from './index.js'

const APP = 'tickle-me-ivories'

function setup() {
  const gw = createFakeGateway({ appSlug: APP, fixedCode: '12345678' })
  const calls: string[] = []
  const fetchSpy: typeof fetch = (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
    return gw.fetch(input, init)
  }
  const client = createPepperhornClient({ appSlug: APP, baseUrl: 'https://apps.test', fetch: fetchSpy, tokenStore: memoryTokenStore(), otpFlowStore: memoryOtpFlow() })
  const wrapper = ({ children }: { children: ReactNode }) => <PhProvider client={client}>{children}</PhProvider>
  return { gw, client, wrapper, calls }
}

async function signIn(client: PhClient, email = 'ana@example.test') {
  await client.auth.requestCode(email)
  await client.auth.verifyCode(email, '12345678')
}

function Status() {
  const a = useAuth()
  return <span data-testid="status">{a.status === 'signed-in' ? `in:${a.user.handle}` : a.status}</span>
}

describe('useAuth', () => {
  it('shares one auth state across components', async () => {
    const { client, wrapper: Wrapper } = setup()
    render(<Wrapper><Status /><Status /></Wrapper>)
    expect(screen.getAllByTestId('status').map((e) => e.textContent)).toEqual(['signed-out', 'signed-out'])
    await act(() => signIn(client))
    expect(screen.getAllByTestId('status').map((e) => e.textContent)).toEqual(['in:player-1', 'in:player-1'])
  })

  it('throws a clear error outside PhProvider', () => {
    expect(() => renderHook(() => useAuth())).toThrow(/PhProvider/)
  })
})

describe('useSaves', () => {
  it('is empty signed out, lists after sign-in, and refreshes after save and remove', async () => {
    const { client, wrapper } = setup()
    const { result } = renderHook(() => useSaves('scene'), { wrapper })
    expect(result.current.items).toEqual([])
    await act(() => signIn(client))
    await act(() => result.current.save({ kind: 'scene', externalId: 'e1', name: 'One', payload: {} }).then(() => undefined))
    await waitFor(() => expect(result.current.items.map((i) => i.externalId)).toEqual(['e1']))
    await act(() => result.current.remove('e1'))
    await waitFor(() => expect(result.current.items).toEqual([]))
  })
})

describe('useShareFromUrl', () => {
  it('waits for auth to leave "unknown" before resolving (chordee ShareResolver rule)', async () => {
    const { client, calls, gw } = setup()
    await signIn(client)
    await client.saves.upsert({ kind: 'scene', externalId: 'e1', name: 'One', payload: { n: 1 } })
    const { code } = await client.shares.createFromSave({ kind: 'scene', externalId: 'e1', visibility: 'link_view' })
    // A fresh client holding the same token starts 'unknown' until restore().
    const token = gw.sessions[0]!.token
    const store = memoryTokenStore()
    store.set(token, '2099-01-01T00:00:00.000Z')
    const restoring = createPepperhornClient({ appSlug: APP, baseUrl: 'https://apps.test', fetch: (i, n) => { calls.push(`${n?.method ?? 'GET'} ${new URL(String(i)).pathname}`); return gw.fetch(i, n) }, tokenStore: store, otpFlowStore: memoryOtpFlow() })
    const w = ({ children }: { children: ReactNode }) => <PhProvider client={restoring}>{children}</PhProvider>
    calls.length = 0
    const { result } = renderHook(() => useShareFromUrl({ pathname: `/s/${code}` }), { wrapper: w })
    expect(result.current.state).toBe('loading')
    await new Promise((r) => setTimeout(r, 50)) // a stable window in which a premature request would land
    expect(result.current.state).toBe('loading')
    expect(calls.some((c) => c.includes('/ph/v1/shares/'))).toBe(false)
    await act(() => restoring.auth.restore().then(() => undefined))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    expect(result.current.share).toMatchObject({ isOwner: true, payload: { n: 1 } })
  })

  it('is "none" off a share path and "missing" for an unknown code', async () => {
    const { wrapper } = setup()
    expect(renderHook(() => useShareFromUrl({ pathname: '/' }), { wrapper }).result.current.state).toBe('none')
    const { result } = renderHook(() => useShareFromUrl({ pathname: '/s/AbCdEfGhJk' }), { wrapper })
    await waitFor(() => expect(result.current.state).toBe('missing'))
  })
})

describe('useSaves loading and kind switches', () => {
  /** Holds GET /ph/v1/saves until released. */
  function gated() {
    const s = setup()
    let release: () => void = () => undefined
    const hold = new Promise<void>((r) => { release = r })
    let armed = false
    const inner = s.gw.fetch
    s.gw.fetch = (async (i: RequestInfo | URL, n?: RequestInit) => {
      if (armed && new URL(String(i)).pathname === '/ph/v1/saves' && (n?.method ?? 'GET') === 'GET') await hold
      return inner(i, n)
    }) as typeof fetch
    return { ...s, release, arm: () => { armed = true } }
  }

  it('loading falls back to false when sign-out interrupts an in-flight list', async () => {
    const { client, wrapper, arm, release } = gated()
    await signIn(client)
    arm()
    const { result } = renderHook(() => useSaves('scene'), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(true))
    await act(() => client.auth.signOut().then(() => undefined))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => { release() })
    expect(result.current.loading).toBe(false)
    expect(result.current.items).toEqual([])
  })

  it('clears the previous kind\'s items when the kind changes', async () => {
    const { client, wrapper, gw } = setup()
    await signIn(client)
    gw.seedSave('ana@example.test', { kind: 'scene', externalId: 'e1', name: 'One', payload: {} })
    const { result, rerender } = renderHook(({ k }) => useSaves(k), { wrapper, initialProps: { k: 'scene' } })
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    rerender({ k: 'look' })
    expect(result.current.items).toEqual([]) // cleared at once, not after the next fetch lands
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual([])
  })
})
