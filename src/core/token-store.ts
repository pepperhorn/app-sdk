// Where the bearer token lives (spec §3.1, §9.3). localStorage by default,
// guarded: a browser that refuses storage (private mode, quota, a sandboxed
// iframe) falls back to memory for the rest of the page's life.

export interface TokenStore {
  get(): string | null
  set(token: string, expiresAt: string): void
  clear(): void
}

interface Stored { token: string; expiresAt: string }

function live(v: unknown, now: number): v is Stored {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.token !== 'string' || o.token.length === 0 || typeof o.expiresAt !== 'string') return false
  const at = Date.parse(o.expiresAt)
  return Number.isFinite(at) && at > now
}

export function memoryTokenStore(now: () => number = Date.now): TokenStore {
  let s: Stored | null = null
  return {
    get() {
      if (live(s, now())) return s.token
      s = null
      return null
    },
    set(token, expiresAt) { s = { token, expiresAt } },
    clear() { s = null },
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function localStorageTokenStore(key: string, now: () => number = Date.now): TokenStore {
  const mem = memoryTokenStore(now)
  let memoryOnly = false
  return {
    get() {
      const ls = storage()
      if (memoryOnly || !ls) return mem.get()
      let raw: string | null
      try {
        raw = ls.getItem(key)
      } catch {
        memoryOnly = true
        return mem.get()
      }
      if (raw === null) return null
      let parsed: unknown = null
      try { parsed = JSON.parse(raw) } catch { parsed = null }
      if (live(parsed, now())) return parsed.token
      try { ls.removeItem(key) } catch { /* nothing more to do */ }
      return null
    },
    set(token, expiresAt) {
      mem.set(token, expiresAt)
      const ls = storage()
      if (!ls) { memoryOnly = true; return }
      try {
        ls.setItem(key, JSON.stringify({ token, expiresAt }))
      } catch {
        memoryOnly = true
      }
    },
    clear() {
      mem.clear()
      try { storage()?.removeItem(key) } catch { /* nothing more to do */ }
    },
  }
}
