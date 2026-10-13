import { afterEach, describe, it, expect, vi } from 'vitest'
import { localStorageTokenStore, memoryTokenStore } from './token-store.js'

const FUTURE = '2099-01-01T00:00:00.000Z'
const PAST = '2000-01-01T00:00:00.000Z'

function fakeStorage(o: { throwOn?: 'get' | 'set' } = {}): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => { if (o.throwOn === 'get') throw new Error('denied'); return m.get(k) ?? null },
    setItem: (k: string, v: string) => { if (o.throwOn === 'set') throw new Error('quota'); m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('memoryTokenStore', () => {
  it('returns the token until it expires', () => {
    const s = memoryTokenStore()
    s.set('t', FUTURE)
    expect(s.get()).toBe('t')
    s.set('t', PAST)
    expect(s.get()).toBeNull()
  })
})

describe('localStorageTokenStore', () => {
  it('persists across instances under its key', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    localStorageTokenStore('ph.session.x').set('t', FUTURE)
    expect(localStorageTokenStore('ph.session.x').get()).toBe('t')
    localStorageTokenStore('ph.session.x').clear()
    expect(localStorageTokenStore('ph.session.x').get()).toBeNull()
  })

  it('drops an expired or malformed entry', () => {
    const ls = fakeStorage()
    vi.stubGlobal('localStorage', ls)
    ls.setItem('k', JSON.stringify({ token: 't', expiresAt: PAST }))
    expect(localStorageTokenStore('k').get()).toBeNull()
    expect(ls.getItem('k')).toBeNull()
    ls.setItem('k', '{not json')
    expect(localStorageTokenStore('k').get()).toBeNull()
  })

  it('keeps working in memory when storage refuses writes or reads', () => {
    vi.stubGlobal('localStorage', fakeStorage({ throwOn: 'set' }))
    const s = localStorageTokenStore('k')
    s.set('t', FUTURE)
    expect(s.get()).toBe('t')
    vi.stubGlobal('localStorage', fakeStorage({ throwOn: 'get' }))
    const r = localStorageTokenStore('k')
    r.set('u', FUTURE)
    expect(r.get()).toBe('u')
  })

  it('works with no localStorage at all (node, workers)', () => {
    const s = localStorageTokenStore('k')
    s.set('t', FUTURE)
    expect(s.get()).toBe('t')
  })
})
