import { z } from 'zod/v4'
import { PhError, isPhError } from './errors.js'
import type { Http } from './http.js'
import { OkSchema, PublicSaveSchema, SaveRowSchema, SaveSummarySchema } from './schemas.js'
import type { PublicSave, SaveRow, SaveSummaryRow, Visibility } from './types.js'

export interface UpsertInput<T> {
  kind: string; externalId: string; name: string; payload: T
  visibility?: Visibility
  /** "The row I last saw": a different stored updatedAt, or no row at all, is a 409 conflict. */
  ifUpdatedAt?: string
}

export interface SavesClient {
  list(q: { kind?: string; cursor?: string; limit?: number }): Promise<{ items: SaveSummaryRow[]; next: string | null }>
  get<T = unknown>(kind: string, externalId: string, schema?: z.ZodType<T>): Promise<SaveRow<T> | null>
  upsert<T>(i: UpsertInput<T>): Promise<SaveRow<T>>
  setVisibility(kind: string, externalId: string, v: Visibility): Promise<void>
  remove(kind: string, externalId: string): Promise<void>
  listPublic(q: { kind: string; cursor?: string }): Promise<{ items: PublicSave[]; next: string | null }>
}

const ListWire = z.object({ ok: z.literal(true), items: z.array(SaveSummarySchema), next: z.string().nullable() })
const RowWire = z.object({ ok: z.literal(true), save: SaveRowSchema(z.unknown()) })
const PublicWire = z.object({ ok: z.literal(true), items: z.array(PublicSaveSchema), next: z.string().nullable() })

const seg = (s: string) => encodeURIComponent(s)

/** Applies a caller schema to an untrusted payload; a mismatch is 'invalid', never 'server'. */
export function checkPayload<T>(payload: unknown, schema: z.ZodType<T> | undefined): T {
  if (!schema) return payload as T
  const r = schema.safeParse(payload)
  if (!r.success) throw new PhError('invalid', { message: 'This item is not in a format this app can open.' })
  return r.data
}

export function createSavesClient(d: { appSlug: string; http: Http }): SavesClient {
  const appSlug = d.appSlug
  return {
    async list(q) {
      const r = await d.http({ method: 'GET', path: '/ph/v1/saves', query: { appSlug, kind: q.kind, cursor: q.cursor, limit: q.limit }, auth: 'required' }, ListWire)
      return { items: r.items, next: r.next }
    },
    async get<T = unknown>(kind: string, externalId: string, schema?: z.ZodType<T>) {
      try {
        const r = await d.http({ method: 'GET', path: `/ph/v1/saves/${seg(kind)}/${seg(externalId)}`, query: { appSlug }, auth: 'required' }, RowWire)
        return { ...r.save, payload: checkPayload(r.save.payload, schema) } as SaveRow<T>
      } catch (e) {
        if (isPhError(e) && e.code === 'not_found') return null
        throw e
      }
    },
    async upsert<T>(i: UpsertInput<T>) {
      const r = await d.http({ method: 'POST', path: '/ph/v1/saves', body: { appSlug, ...i }, auth: 'required' }, RowWire)
      return r.save as SaveRow<T>
    },
    async setVisibility(kind, externalId, v) {
      await d.http({ method: 'PATCH', path: `/ph/v1/saves/${seg(kind)}/${seg(externalId)}`, body: { appSlug, visibility: v }, auth: 'required' }, RowWire)
    },
    async remove(kind, externalId) {
      await d.http({ method: 'DELETE', path: `/ph/v1/saves/${seg(kind)}/${seg(externalId)}`, query: { appSlug }, auth: 'required' }, OkSchema)
    },
    async listPublic(q) {
      const r = await d.http({ method: 'GET', path: '/ph/v1/public', query: { appSlug, kind: q.kind, cursor: q.cursor }, auth: 'none' }, PublicWire)
      return { items: r.items, next: r.next }
    },
  }
}
