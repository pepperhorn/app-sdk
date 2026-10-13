// AuthStore (spec §3.1): one module-pattern store per client. Snapshots are
// immutable, replaced on every change, so React's useSyncExternalStore and
// the tickle plugin can compare them by reference.
import { z } from 'zod/v4'
import { PhError, isPhError } from './errors.js'
import type { Http } from './http.js'
import type { TokenStore } from './token-store.js'
import type { OtpFlowStore } from './otp-flow.js'
import { AuthUserSchema, DeviceWireSchema, OkSchema } from './schemas.js'
import type { AuthSnapshot, AuthUser, Device } from './types.js'

export interface AuthStore {
  getSnapshot(): AuthSnapshot
  subscribe(listener: () => void): () => void
  /** GET /otp-auth/session. Keeps the token on network/5xx/429 and retries with backoff; clears it only on 401. */
  restore(): Promise<AuthSnapshot>
  /** POST /ph/v1/enroll, then POST /otp-auth/code. Resolves for any well-formed email (no enumeration). */
  requestCode(email: string): Promise<void>
  /** POST /otp-auth/verify, then GET /ph/v1/me. PhError('invalid_code') on a wrong or expired code. */
  verifyCode(email: string, code: string): Promise<AuthUser>
  /** POST /otp-auth/logout; the local token is cleared even if that fails. */
  signOut(): Promise<void>
  signOutEverywhere(): Promise<number>
  devices(): Promise<Device[]>
  /** Revoking the current device signs this client out. */
  revokeDevice(id: string): Promise<void>
  updateProfile(p: Partial<Pick<AuthUser, 'firstName' | 'lastName' | 'handle'>>): Promise<AuthUser>
  /** Escape hatch for gateway routes the SDK does not wrap (files). Same origin as baseUrl only. */
  authorizedFetch(input: string, init?: RequestInit): Promise<Response>
}

export interface AuthStoreInternal extends AuthStore {
  /** Called by http after a 401 that cleared the token. */
  handleUnauthorized(): void
}

export interface AuthDeps {
  appSlug: string
  baseUrl: string
  http: Http
  fetch: typeof fetch
  tokens: TokenStore
  otp: OtpFlowStore
  now: () => number
  appVersion?: string | undefined
  deviceLabel?: string | undefined
}

export const RESTORE_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const SessionWire = z.object({ ok: z.literal(true), appSlug: z.string(), expiresAt: z.string() })
const VerifyWire = z.object({ ok: z.literal(true), token: z.string().min(1), expiresAt: z.string() })
const MeWire = z.object({ ok: z.literal(true), user: AuthUserSchema })
const LogoutAllWire = z.object({ ok: z.literal(true), revoked: z.number() })
const SessionsWire = z.object({ ok: z.literal(true), sessions: z.array(DeviceWireSchema) })

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function createAuthStore(d: AuthDeps): AuthStoreInternal {
  const listeners = new Set<() => void>()
  const signedOut = (): AuthSnapshot => ({ status: 'signed-out', pending: d.otp.load() })
  let snapshot: AuthSnapshot = d.tokens.get() ? { status: 'unknown' } : signedOut()
  let inflight: Promise<AuthSnapshot> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  // Bumped by every sign-in/sign-out so a restore that started earlier
  // cannot overwrite what happened while it was in flight.
  let epoch = 0
  const q = { appSlug: d.appSlug }

  const set = (s: AuthSnapshot) => {
    snapshot = s
    for (const l of [...listeners]) l()
  }
  const stopRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
    attempt = 0
  }
  const endSession = () => {
    epoch++
    stopRetry()
    d.tokens.clear()
    set({ status: 'signed-out', pending: null })
  }
  const readMe = async () => (await d.http({ method: 'GET', path: '/ph/v1/me', query: q, auth: 'required' }, MeWire)).user

  const store: AuthStoreInternal = {
    getSnapshot: () => snapshot,
    subscribe(l) {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },

    restore() {
      if (inflight) return inflight
      const mine = epoch
      inflight = (async (): Promise<AuthSnapshot> => {
        if (!d.tokens.get()) {
          stopRetry()
          set(signedOut())
          return snapshot
        }
        try {
          const session = await d.http({ method: 'GET', path: '/otp-auth/session', query: q, auth: 'required' }, SessionWire)
          const user = await readMe()
          if (mine === epoch) {
            stopRetry()
            set({ status: 'signed-in', user, expiresAt: session.expiresAt })
          }
        } catch (e) {
          if (mine !== epoch) return snapshot
          if (isPhError(e) && e.code === 'unauthorized') {
            stopRetry()
            set(signedOut())
          } else if (isPhError(e) && e.status !== undefined && e.status >= 400 && e.status < 500 && e.code !== 'rate_limited') {
            // A 400 (unknown app slug) or 403 (origin refused) will not fix
            // itself: stop retrying and show signed-out. The token is kept
            // (only a 401 clears it); a later explicit restore() may retry.
            stopRetry()
            set(signedOut())
          } else {
            // Offline, 5xx or 429: the session may be fine. Keep the token, stay
            // 'unknown' (or signed-in if we already were) and try again later.
            if (snapshot.status === 'signed-out') set({ status: 'unknown' })
            if (retryTimer === null) {
              const base = RESTORE_BACKOFF_MS[Math.min(attempt, RESTORE_BACKOFF_MS.length - 1)]!
              const wait = Math.max(base, ((isPhError(e) ? e.retryAfterSec : undefined) ?? 0) * 1000)
              attempt++
              retryTimer = setTimeout(() => {
                retryTimer = null
                void store.restore()
              }, wait)
            }
          }
        }
        return snapshot
      })().finally(() => { inflight = null })
      return inflight
    },

    async requestCode(email) {
      const e = normalizeEmail(email)
      if (e.length > 254 || !EMAIL_RE.test(e)) throw new PhError('invalid', { message: 'Enter a valid email address.' })
      await d.http({ method: 'POST', path: '/ph/v1/enroll', body: { email: e, appSlug: d.appSlug }, auth: 'none' }, OkSchema)
      await d.http({ method: 'POST', path: '/otp-auth/code', body: { email: e, appSlug: d.appSlug }, auth: 'none' }, OkSchema)
      const pending = { email: e, codeSentAt: d.now() }
      d.otp.save(pending)
      if (snapshot.status !== 'signed-in') set({ status: 'signed-out', pending })
    },

    async verifyCode(email, code) {
      const e = normalizeEmail(email)
      const c = code.replace(/\s+/g, '')
      if (!/^\d{4,12}$/.test(c)) throw new PhError('invalid_code')
      let v: z.infer<typeof VerifyWire>
      try {
        v = await d.http({
          method: 'POST', path: '/otp-auth/verify', auth: 'none',
          body: { email: e, code: c, appSlug: d.appSlug, transport: 'bearer', appVersion: d.appVersion, deviceLabel: d.deviceLabel },
        }, VerifyWire)
      } catch (err) {
        if (isPhError(err) && err.code === 'unauthorized') throw new PhError('invalid_code', { status: 401 })
        throw err
      }
      epoch++
      stopRetry()
      d.tokens.set(v.token, v.expiresAt)
      let user: AuthUser
      try {
        user = await readMe()
      } catch (err) {
        void store.restore()
        throw err
      }
      d.otp.clear()
      set({ status: 'signed-in', user, expiresAt: v.expiresAt })
      return user
    },

    async signOut() {
      if (d.tokens.get()) {
        try {
          await d.http({ method: 'POST', path: '/otp-auth/logout', body: { appSlug: d.appSlug }, auth: 'required' }, OkSchema)
        } catch {
          // The local sign-out stands either way.
        }
      }
      d.otp.clear()
      endSession()
    },

    async signOutEverywhere() {
      const r = await d.http({ method: 'POST', path: '/otp-auth/logout-all', body: { appSlug: d.appSlug }, auth: 'required' }, LogoutAllWire)
      endSession()
      return r.revoked
    },

    async devices() {
      const r = await d.http({ method: 'GET', path: '/otp-auth/sessions', query: q, auth: 'required' }, SessionsWire)
      return r.sessions.map((s) => ({
        id: s.id, appSlug: s.appSlug, label: s.deviceLabel, userAgent: s.userAgent,
        lastAccessAt: s.lastAccessAt, expiresAt: s.expiresAt, current: s.current,
      }))
    },

    async revokeDevice(id) {
      const target = (await store.devices()).find((x) => x.id === id)
      if (!target) throw new PhError('not_found')
      await d.http({ method: 'DELETE', path: `/otp-auth/sessions/${encodeURIComponent(id)}`, query: q, auth: 'required' }, OkSchema)
      if (target.current) endSession()
    },

    async updateProfile(p) {
      const r = await d.http({ method: 'PATCH', path: '/ph/v1/me', body: { appSlug: d.appSlug, ...p }, auth: 'required' }, MeWire)
      if (snapshot.status === 'signed-in') set({ ...snapshot, user: r.user })
      return r.user
    },

    async authorizedFetch(input, init = {}) {
      const url = /^https?:\/\//i.test(input) ? input : `${d.baseUrl}${input.startsWith('/') ? '' : '/'}${input}`
      if (new URL(url).origin !== new URL(d.baseUrl).origin) {
        throw new PhError('invalid', { message: 'authorizedFetch only calls PepperHorn.' })
      }
      const token = d.tokens.get()
      if (!token) {
        store.handleUnauthorized()
        throw new PhError('unauthorized')
      }
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${token}`)
      let res: Response
      try {
        res = await d.fetch(url, { ...init, headers })
      } catch {
        throw new PhError('network')
      }
      if (res.status === 401) {
        d.tokens.clear()
        store.handleUnauthorized()
      }
      return res
    },

    handleUnauthorized() {
      epoch++
      stopRetry()
      set({ status: 'signed-out', pending: null })
    },
  }
  return store
}
