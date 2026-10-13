import type { z } from 'zod/v4'
import type { AuthUserSchema, PublicSaveSchema, SaveSummarySchema, ShareCreatedSchema, VisibilitySchema } from './schemas.js'

export type Visibility = z.infer<typeof VisibilitySchema>
/** Never carries ph_uid (D14). */
export type AuthUser = z.infer<typeof AuthUserSchema>
export interface PendingOtp { email: string; codeSentAt: number }
export type AuthSnapshot =
  | { status: 'unknown' }
  | { status: 'signed-out'; pending: PendingOtp | null }
  | { status: 'signed-in'; user: AuthUser; expiresAt: string }
export interface Device {
  id: string; appSlug: string; label: string | null; userAgent: string | null
  lastAccessAt: string | null; expiresAt: string; current: boolean
}
export type SaveSummaryRow = z.infer<typeof SaveSummarySchema>
export interface SaveRow<T> {
  id: string; appSlug: string; kind: string; externalId: string; name: string
  payload: T; visibility: Visibility; forkedFrom: string | null
  createdAt: string; updatedAt: string
}
export type PublicSave = z.infer<typeof PublicSaveSchema>
export type ShareCreated = z.infer<typeof ShareCreatedSchema>
export interface ResolvedShare<T> {
  code: string; appSlug: string; kind: string; payload: T
  owner: { handle: string } | null; visibility: Visibility
  isOwner: boolean; canEdit: boolean; canFork: boolean
  viewCount: number; createdAt: string
}
