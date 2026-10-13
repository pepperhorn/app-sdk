import type { z } from 'zod/v4'
import { PhError, errorFromResponse } from './errors.js'
import type { TokenStore } from './token-store.js'

export type AuthMode = 'none' | 'optional' | 'required'

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  auth: AuthMode
}

export interface HttpDeps {
  baseUrl: string
  fetch: typeof fetch
  tokens: TokenStore
  /** After a 401 on a request that carried the token (already cleared), or a required call with no token. */
  onUnauthorized(): void
  now?: () => number
}

export type Http = <T>(req: HttpRequest, schema: z.ZodType<T>) => Promise<T>

export function buildUrl(baseUrl: string, path: string, query?: HttpRequest['query']): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
  return url.href
}

/**
 * JSON over fetch with bearer injection (spec §3.1). Rules:
 * - a rejected fetch is `network`; a non-2xx is errorFromResponse; a 2xx
 *   body that fails `schema` is `server`;
 * - only a 401 on a request that carried the token clears it (never a 429
 *   or a 5xx: the gate 0.6 "session 429 is retry" note);
 * - `optional` auth retries once without a stale token, because the gateway
 *   answers a bad optional token with 401 rather than falling back.
 */
export function createHttp(d: HttpDeps): Http {
  const now = d.now ?? Date.now

  async function send(req: HttpRequest, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (req.body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    const init: RequestInit = { method: req.method, headers }
    if (req.body !== undefined) init.body = JSON.stringify(req.body)
    try {
      return await d.fetch(buildUrl(d.baseUrl, req.path, req.query), init)
    } catch {
      throw new PhError('network')
    }
  }

  return async function http<T>(req: HttpRequest, schema: z.ZodType<T>): Promise<T> {
    const token = req.auth === 'none' ? null : d.tokens.get()
    if (req.auth === 'required' && !token) {
      d.onUnauthorized()
      throw new PhError('unauthorized')
    }
    let res = await send(req, token)
    if (res.status === 401 && token) {
      d.tokens.clear()
      d.onUnauthorized()
      if (req.auth === 'optional') res = await send(req, null)
    }
    if (!res.ok) throw await errorFromResponse(res, now())
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new PhError('server', { status: res.status })
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw new PhError('server', { status: res.status })
    return parsed.data
  }
}
