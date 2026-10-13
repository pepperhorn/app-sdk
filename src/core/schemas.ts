// zod envelopes for every wire shape (spec §3.1). Wire shapes are copied from
// ph-apps-extensions endpoints/ph/src/wire.ts and routes/*.ts, and from
// directus-otp-auth routes.js. `payload` defaults to z.unknown(): the app
// validates its own content. z.object strips unknown keys.
import { z } from 'zod/v4'

export const VisibilitySchema = z.enum(['private', 'link_view', 'link_edit', 'public'])

export const OkSchema = z.object({ ok: z.literal(true) })

export const ErrorBodySchema = z.object({
  ok: z.literal(false),
  error: z.string().optional(),
  detail: z.string().optional(),
  retryAfterSec: z.number().optional(),
})

export const AuthUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  handle: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
})

export const SaveSummarySchema = z.object({
  id: z.string(),
  appSlug: z.string(),
  kind: z.string(),
  externalId: z.string(),
  name: z.string(),
  visibility: VisibilitySchema,
  forkedFrom: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  bytes: z.number(),
})

export function SaveRowSchema<T>(payload: z.ZodType<T>) {
  return z.object({
    id: z.string(),
    appSlug: z.string(),
    kind: z.string(),
    externalId: z.string(),
    name: z.string(),
    payload,
    visibility: VisibilitySchema,
    forkedFrom: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
}

export const PublicSaveSchema = z.object({
  externalId: z.string(),
  name: z.string(),
  kind: z.string(),
  ownerHandle: z.string().nullable(),
  updatedAt: z.string(),
  shareCode: z.string().nullable(),
})

export const ShareCreatedSchema = z.object({
  code: z.string(),
  url: z.string(),
  shortUrl: z.string().nullable(),
  revokeKey: z.string().optional(),
})

export function ResolvedShareSchema<T>(payload: z.ZodType<T>) {
  return z.object({
    code: z.string(),
    appSlug: z.string(),
    kind: z.string(),
    payload,
    owner: z.object({ handle: z.string() }).nullable(),
    visibility: VisibilitySchema,
    isOwner: z.boolean(),
    canEdit: z.boolean(),
    canFork: z.boolean(),
    viewCount: z.number(),
    createdAt: z.string(),
  })
}

/** otp-auth GET /sessions rows (session.js listSessions); `ip` is read by nobody and dropped. */
export const DeviceWireSchema = z.object({
  id: z.string(),
  appSlug: z.string(),
  deviceLabel: z.string().nullable(),
  userAgent: z.string().nullable(),
  lastAccessAt: z.string().nullable(),
  expiresAt: z.string(),
  current: z.boolean(),
})
