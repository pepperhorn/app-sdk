// PhError: the only error the SDK throws (spec §3.1). Its message is always
// user-safe and comes from this file, never from a server body; the server's
// machine-readable `detail` is kept separately when it is a plain token.

export type PhErrorCode =
  | 'network' | 'unavailable' | 'unauthorized' | 'forbidden' | 'not_found'
  | 'conflict' | 'rate_limited' | 'too_large' | 'invalid' | 'invalid_code'
  | 'upload_requires_sign_in' | 'server'

export const PH_ERROR_CODES: readonly PhErrorCode[] = [
  'network', 'unavailable', 'unauthorized', 'forbidden', 'not_found', 'conflict',
  'rate_limited', 'too_large', 'invalid', 'invalid_code', 'upload_requires_sign_in', 'server',
]

const MESSAGES: Record<PhErrorCode, string> = {
  network: 'Could not reach PepperHorn. Check your connection and try again.',
  unavailable: 'PepperHorn is temporarily unavailable. Try again in a moment.',
  unauthorized: 'Your session has ended. Sign in again.',
  forbidden: 'You do not have permission to do that.',
  not_found: 'That could not be found.',
  conflict: 'This was changed somewhere else. Reload and try again.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
  too_large: 'That is too large to save.',
  invalid: 'That request was not valid.',
  invalid_code: 'That code is not right, or it has expired.',
  upload_requires_sign_in: 'Sign in to share a file you uploaded.',
  server: 'Something went wrong on our side. Try again later.',
}

const DETAIL_MESSAGES: Record<string, string> = {
  quota: 'You have reached the limit of saves for this app. Delete some to make room.',
  handle_taken: 'That handle is already taken.',
  newer_version: 'This was made with a newer version of the app.',
}

export interface PhErrorInit { status?: number; retryAfterSec?: number; detail?: string; message?: string }

function messageFor(code: PhErrorCode, init: PhErrorInit): string {
  const byDetail = init.detail ? DETAIL_MESSAGES[init.detail] : undefined
  if (byDetail) return byDetail
  if (code === 'rate_limited' && init.retryAfterSec !== undefined) {
    return `Too many attempts. Try again in ${Math.max(1, Math.ceil(init.retryAfterSec))} seconds.`
  }
  return MESSAGES[code]
}

export class PhError extends Error {
  readonly code: PhErrorCode
  readonly status: number | undefined
  readonly retryAfterSec: number | undefined
  readonly detail: string | undefined

  constructor(code: PhErrorCode, init: PhErrorInit = {}) {
    super(init.message ?? messageFor(code, init))
    this.name = 'PhError'
    this.code = code
    this.status = init.status
    this.retryAfterSec = init.retryAfterSec
    this.detail = init.detail
  }
}

/** Shape check, so an error from a second copy of the SDK still matches. */
export function isPhError(e: unknown): e is PhError {
  return e instanceof Error && e.name === 'PhError'
    && PH_ERROR_CODES.includes((e as { code?: unknown }).code as PhErrorCode)
}

export function codeForStatus(status: number): PhErrorCode {
  switch (status) {
    case 400: case 415: case 422: return 'invalid'
    case 401: return 'unauthorized'
    case 403: return 'forbidden'
    case 404: case 410: return 'not_found'
    case 409: return 'conflict'
    case 413: return 'too_large'
    case 429: return 'rate_limited'
    case 502: case 503: case 504: return 'unavailable'
    default: return status >= 500 ? 'server' : 'invalid'
  }
}

const DETAIL_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function retryAfter(res: Response, fromBody: unknown, now: number): number | undefined {
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return fromBody
  const h = res.headers.get('retry-after')?.trim()
  if (!h) return undefined
  if (/^\d+$/.test(h)) return Number(h)
  const at = Date.parse(h)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined
}

/**
 * The PhError for a non-2xx response. Reads the gateway's shared body
 * `{ ok:false, error, detail?, retryAfterSec? }` when present; otp-auth's
 * uniform `{ ok:false }`, a Directus error chain or a non-JSON body map by
 * status alone.
 */
export async function errorFromResponse(res: Response, now: number = Date.now()): Promise<PhError> {
  let body: unknown = null
  try { body = await res.json() } catch { body = null }
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const named = typeof b.error === 'string' && b.error !== 'network' && PH_ERROR_CODES.includes(b.error as PhErrorCode)
    ? (b.error as PhErrorCode)
    : null
  const code = named ?? codeForStatus(res.status)
  const init: PhErrorInit = { status: res.status }
  if (typeof b.detail === 'string' && DETAIL_RE.test(b.detail)) init.detail = b.detail
  if (code === 'rate_limited') {
    const r = retryAfter(res, b.retryAfterSec, now)
    if (r !== undefined) init.retryAfterSec = r
  }
  return new PhError(code, init)
}
