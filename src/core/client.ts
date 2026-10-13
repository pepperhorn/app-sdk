import { createHttp } from './http.js'
import { localStorageTokenStore, type TokenStore } from './token-store.js'
import { localStorageOtpFlow, type OtpFlowStore } from './otp-flow.js'
import { createAuthStore, type AuthStore, type AuthStoreInternal } from './auth.js'

export const DEFAULT_BASE_URL = 'https://apps.pepperhorn.com'
const SLUG_RE = /^[a-z0-9-]{1,50}$/

export interface PhClientOptions {
  /** Must be in OTP_AUTH_APP_SLUGS and the gateway registry. */
  appSlug: string
  baseUrl?: string
  appVersion?: string
  deviceLabel?: string
  /** Default localStorageTokenStore(`ph.session.${appSlug}`). */
  tokenStore?: TokenStore
  /** Default localStorageOtpFlow(`ph.otp.${appSlug}`). */
  otpFlowStore?: OtpFlowStore
  fetch?: typeof fetch
  now?: () => number
}

export interface PhClient {
  readonly appSlug: string
  readonly baseUrl: string
  auth: AuthStore
}

export function createPepperhornClient(o: PhClientOptions): PhClient {
  if (!SLUG_RE.test(o.appSlug)) throw new TypeError('createPepperhornClient: appSlug must match /^[a-z0-9-]{1,50}$/')
  const baseUrl = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const now = o.now ?? Date.now
  const tokens = o.tokenStore ?? localStorageTokenStore(`ph.session.${o.appSlug}`, now)
  const otp = o.otpFlowStore ?? localStorageOtpFlow(`ph.otp.${o.appSlug}`, now)
  // Late-bound so a test (or a polyfill) that replaces globalThis.fetch later still applies.
  const fetchImpl: typeof fetch = o.fetch ?? ((input, init) => globalThis.fetch(input, init))
  let auth: AuthStoreInternal | null = null
  const http = createHttp({ baseUrl, fetch: fetchImpl, tokens, now, onUnauthorized: () => auth?.handleUnauthorized() })
  auth = createAuthStore({
    appSlug: o.appSlug, baseUrl, http, fetch: fetchImpl, tokens, otp, now,
    appVersion: o.appVersion, deviceLabel: o.deviceLabel,
  })
  return { appSlug: o.appSlug, baseUrl, auth }
}
