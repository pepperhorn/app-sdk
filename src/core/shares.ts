import { z } from 'zod/v4'
import { isPhError } from './errors.js'
import type { Http } from './http.js'
import { OkSchema, ResolvedShareSchema, SaveRowSchema, ShareCreatedSchema } from './schemas.js'
import { checkPayload } from './saves.js'
import type { ResolvedShare, SaveRow, ShareCreated, Visibility } from './types.js'

/** Gateway share codes: 10 characters of base57, a subset of [A-Za-z0-9]. */
export const SHARE_CODE_RE = /^[A-Za-z0-9]{10}$/
export const DEFAULT_SHARE_PATH_RE = /^\/s\/([A-Za-z0-9]{10})\/?$/

export function parseShareCode(pathname: string, pattern: RegExp = DEFAULT_SHARE_PATH_RE): string | null {
  const code = pattern.exec(pathname)?.[1]
  return code && SHARE_CODE_RE.test(code) ? code : null
}

export interface SharesClient {
  createAnonymous<T>(i: { kind: string; payload: T }): Promise<ShareCreated>
  createFromSave(i: { kind: string; externalId: string; visibility: Exclude<Visibility, 'private'> }): Promise<ShareCreated>
  resolve<T = unknown>(code: string, schema?: z.ZodType<T>): Promise<ResolvedShare<T> | null>
  update<T>(code: string, payload: T): Promise<void>
  fork<T = unknown>(code: string, i: { externalId: string; name: string }): Promise<SaveRow<T>>
  revoke(code: string, revokeKey?: string): Promise<void>
}

const CreatedWire = ShareCreatedSchema.extend({ ok: z.literal(true) })
const ResolveWire = z.object({ ok: z.literal(true), share: ResolvedShareSchema(z.unknown()) })
const ForkWire = z.object({ ok: z.literal(true), save: SaveRowSchema(z.unknown()) })

const strip = ({ ok: _ok, ...rest }: z.infer<typeof CreatedWire>): ShareCreated => rest

export function createSharesClient(d: { appSlug: string; http: Http }): SharesClient {
  const appSlug = d.appSlug
  const path = (code: string) => `/ph/v1/shares/${encodeURIComponent(code)}`
  return {
    async createAnonymous(i) {
      return strip(await d.http({ method: 'POST', path: '/ph/v1/shares', body: { appSlug, kind: i.kind, payload: i.payload }, auth: 'optional' }, CreatedWire))
    },
    async createFromSave(i) {
      return strip(await d.http({ method: 'POST', path: '/ph/v1/shares', body: { appSlug, kind: i.kind, externalId: i.externalId, visibility: i.visibility }, auth: 'required' }, CreatedWire))
    },
    async resolve<T = unknown>(code: string, schema?: z.ZodType<T>) {
      if (!SHARE_CODE_RE.test(code)) return null
      try {
        const r = await d.http({ method: 'GET', path: path(code), query: { appSlug }, auth: 'optional' }, ResolveWire)
        return { ...r.share, payload: checkPayload(r.share.payload, schema) } as ResolvedShare<T>
      } catch (e) {
        if (isPhError(e) && e.code === 'not_found') return null
        throw e
      }
    },
    async update(code, payload) {
      await d.http({ method: 'PATCH', path: path(code), body: { appSlug, payload }, auth: 'required' }, OkSchema)
    },
    async fork<T = unknown>(code: string, i: { externalId: string; name: string }) {
      const r = await d.http({ method: 'POST', path: `${path(code)}/fork`, body: { appSlug, externalId: i.externalId, name: i.name }, auth: 'required' }, ForkWire)
      return r.save as SaveRow<T>
    },
    async revoke(code, revokeKey) {
      await d.http({
        method: 'DELETE', path: path(code), query: { appSlug },
        body: revokeKey === undefined ? {} : { revokeKey },
        auth: revokeKey === undefined ? 'required' : 'optional',
      }, OkSchema)
    },
  }
}
