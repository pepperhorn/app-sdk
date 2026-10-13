// An in-memory stand-in for apps.pepperhorn.com: directus-otp-auth in bearer
// mode (/otp-auth/*) and the ph gateway (/ph/v1/*). Wire shapes and status
// codes follow ph-apps-extensions endpoints/ph/src and directus-otp-auth
// routes.js. Test and local-dev use only: no persistence, no rate limits, no
// phrn.link sync (shortUrl is null unless `shortLinks`), no ph_uid anywhere.
// Known differences from the real gateway: fork does not re-run the kind
// validator; PATCH /me does not apply HANDLE_RE; /otp-auth/code has no 403
// origin-refused path; generated handles are `player-N`, not musical words.
import type { Visibility } from '../core/types.js'

export type FakeValidateResult = { ok: true } | { ok: false; code: 'invalid' | 'upload_requires_sign_in'; detail: string }
export interface FakeKind {
  maxBytes: number
  validate?(payload: unknown, ctx: { signedIn: boolean }): FakeValidateResult
  /** Default true; false makes payload shares a 403 forbidden/anonymous_share_disabled. */
  anonymousShare?: boolean
}
export interface FakeGatewayOptions {
  appSlug?: string
  shareOrigin?: string
  /** Every code mailed is this one; default: random 8 digits. */
  fixedCode?: string
  kinds?: Record<string, FakeKind>
  shortLinks?: boolean
  now?: () => number
}
export interface FakeUser { id: string; email: string; handle: string; firstName: string | null; lastName: string | null }
export interface FakeSave {
  id: string; userId: string; kind: string; externalId: string; name: string; payload: unknown
  visibility: Visibility; forkedFrom: string | null; createdAt: number; updatedAt: number
}
export interface FakeShare {
  code: string; kind: string; userId: string | null; externalId: string | null; payload: unknown
  revokeKey: string | null; status: 'active' | 'revoked'; viewCount: number; createdAt: number; shortSlug: string | null
}
export interface FakeSession {
  id: string; token: string; userId: string; appSlug: string; deviceLabel: string | null
  userAgent: string | null; expiresAt: number; lastAccessAt: number; revoked: boolean
}
export interface FakeGateway {
  fetch: typeof fetch
  users: Map<string, FakeUser>
  saves: Map<string, FakeSave>
  shares: Map<string, FakeShare>
  sessions: FakeSession[]
  lastCode(email: string): string | null
  failNext(route: string, status: number, body?: unknown, headers?: Record<string, string>): void
  seedSave(email: string, s: { kind: string; externalId: string; name: string; payload: unknown; visibility?: Visibility }): FakeSave
}

const BASE57 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const DAY = 86_400_000
const VISIBILITIES: readonly string[] = ['private', 'link_view', 'link_edit', 'public']
const SHARE_VIS: readonly string[] = ['link_view', 'link_edit', 'public']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CODE_RE = /^[A-Za-z0-9]{10}$/
const BEARER_RE = /^Bearer ([0-9a-f-]{36}\.[A-Za-z0-9_-]{16,})$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NAME_MAX = 128
const MAX_SAVES_PER_USER = 500
const SAVES_PAGE = { def: 50, max: 100 }
const PUBLIC_PAGE = 50

const pick = (alphabet: string, n: number) =>
  Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
const iso = (ms: number) => new Date(ms).toISOString()
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const ok = (body: object = {}) => reply(200, { ok: true, ...body })
/** Gateway shape when `error` is given; otp-auth's uniform {ok:false} otherwise. */
const fail = (status: number, error?: string, detail?: string) =>
  reply(status, error ? { ok: false, error, ...(detail ? { detail } : {}) } : { ok: false })
const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
/** validate.ts requireText: trimmed, non-empty, at most `max` code points; null when not. */
const text = (v: unknown, max: number) => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 && [...t].length <= max ? t : null
}
const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v) ?? '').length
const b64url = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string): unknown => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')))

/** A thrown gateway error, turned into the shared error body by `fetch`. */
class Fail {
  readonly res: Response
  constructor(res: Response) { this.res = res }
}
const bail = (status: number, error: string, detail?: string): never => { throw new Fail(fail(status, error, detail)) }

export function createFakeGateway(o: FakeGatewayOptions = {}): FakeGateway {
  const appSlug = o.appSlug ?? 'test-app'
  const shareOrigin = o.shareOrigin ?? 'https://app.test'
  const now = o.now ?? Date.now
  const users = new Map<string, FakeUser>()
  const codes = new Map<string, string>()
  const saves = new Map<string, FakeSave>()
  const shares = new Map<string, FakeShare>()
  const sessions: FakeSession[] = []
  const failures = new Map<string, Array<() => Response>>()
  let handles = 0

  const userById = (id: string | null) => [...users.values()].find((u) => u.id === id) ?? null
  const enroll = (email: string): FakeUser => {
    let u = users.get(email)
    if (!u) {
      u = { id: crypto.randomUUID(), email, handle: `player-${++handles}`, firstName: null, lastName: null }
      users.set(email, u)
    }
    return u
  }
  const kindOf = (kind: unknown): FakeKind | null => {
    if (typeof kind !== 'string') return null
    if (o.kinds) return Object.hasOwn(o.kinds, kind) ? o.kinds[kind]! : null
    return /^[a-z][a-z0-9_-]{0,31}$/.test(kind) ? { maxBytes: 256 * 1024 } : null
  }
  const requireKind = (kind: unknown): FakeKind => kindOf(kind) ?? bail(400, 'invalid', 'unknown_kind')
  const requireExternalId = (v: unknown): string => (typeof v === 'string' && EXT_RE.test(v) ? v : bail(400, 'invalid', 'externalId'))
  const optionalVisibility = (v: unknown): Visibility | undefined => {
    if (v === undefined) return undefined
    return typeof v === 'string' && VISIBILITIES.includes(v) ? (v as Visibility) : bail(400, 'invalid', 'visibility')
  }
  /** null = no Authorization header; 'bad' = a header that does not verify (always a 401). */
  const sessionOf = (h: Headers): FakeSession | null | 'bad' => {
    const a = h.get('authorization')
    if (!a) return null
    const m = BEARER_RE.exec(a)
    const s = m && sessions.find((x) => x.token === m[1] && !x.revoked && x.expiresAt > now() && x.appSlug === appSlug)
    if (!s || !userById(s.userId)) return 'bad'
    s.lastAccessAt = now()
    return s
  }
  const userWire = (u: FakeUser) => ({ id: u.id, email: u.email, handle: u.handle, firstName: u.firstName, lastName: u.lastName })
  const saveWire = (s: FakeSave, withPayload: boolean) => ({
    id: s.id, appSlug, kind: s.kind, externalId: s.externalId, name: s.name,
    ...(withPayload ? { payload: s.payload } : {}),
    visibility: s.visibility, forkedFrom: s.forkedFrom, createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt),
    ...(withPayload ? {} : { bytes: bytesOf(s.payload) }),
  })
  /** Spec §6.3 validation order: present, size (413), then the kind's validator. */
  const checkPayload = (k: FakeKind, payload: unknown, signedIn: boolean) => {
    if (payload === undefined) bail(400, 'invalid', 'payload_required')
    if (bytesOf(payload) > k.maxBytes) bail(413, 'too_large')
    const v = k.validate ? k.validate(payload, { signedIn }) : { ok: true as const }
    if (!v.ok) bail(v.code === 'upload_requires_sign_in' ? 403 : 400, v.code, v.detail)
  }
  const assertQuota = (userId: string) => {
    if ([...saves.values()].filter((s) => s.userId === userId).length >= MAX_SAVES_PER_USER) bail(409, 'conflict', 'quota')
  }
  const activeShareOf = (userId: string, kind: string, externalId: string) =>
    [...shares.values()].filter((x) => x.status === 'active' && x.userId === userId && x.kind === kind && x.externalId === externalId)
      .sort((a, z) => z.createdAt - a.createdAt)[0] ?? null
  const newShare = (p: Pick<FakeShare, 'kind' | 'userId' | 'externalId' | 'payload' | 'revokeKey'>): FakeShare => {
    let code = pick(BASE57, 10)
    while (shares.has(code)) code = pick(BASE57, 10)
    const sh: FakeShare = { ...p, code, status: 'active', viewCount: 0, createdAt: now(), shortSlug: o.shortLinks ? pick(BASE62, 7) : null }
    shares.set(code, sh)
    return sh
  }
  const created = (sh: FakeShare, revokeKey?: string) => ok({
    code: sh.code, url: `${shareOrigin}/s/${sh.code}`,
    shortUrl: sh.shortSlug ? `https://phrn.link/${sh.shortSlug}` : null,
    ...(revokeKey ? { revokeKey } : {}),
  })
  /** What a caller may see, or null (404): missing, revoked, or an owned share whose save is gone or private. */
  const view = (code: string) => {
    const sh = CODE_RE.test(code) ? shares.get(code) : undefined
    if (!sh || sh.status !== 'active') return null
    if (sh.externalId === null) return { sh, payload: sh.payload, visibility: 'link_view' as Visibility, owner: null, save: null }
    const save = saves.get(`${sh.userId}|${sh.kind}|${sh.externalId}`)
    const owner = userById(sh.userId)
    if (!save || !owner || save.visibility === 'private') return null
    return { sh, payload: save.payload, visibility: save.visibility, owner, save }
  }
  const revokeSharesOf = (userId: string, kind: string, externalId: string) => {
    for (const sh of shares.values()) if (sh.userId === userId && sh.kind === kind && sh.externalId === externalId) sh.status = 'revoked'
  }
  const pageLimit = (v: string | null) => {
    if (v === null) return SAVES_PAGE.def
    const n = /^[0-9]{1,4}$/.test(v) ? Number(v) : NaN
    return n >= 1 && n <= SAVES_PAGE.max ? n : bail(400, 'invalid', 'limit')
  }
  /** Opaque base64url keyset cursors, as wire.ts mints them; anything else is 400 invalid/cursor. */
  const decodeCursor = (v: string | null, arity: number): unknown[] | null => {
    if (v === null) return null
    let parsed: unknown
    try {
      parsed = /^[A-Za-z0-9_-]{1,1024}$/.test(v) ? unb64url(v) : null
    } catch {
      parsed = null
    }
    if (!Array.isArray(parsed) || parsed.length !== arity || typeof parsed[0] !== 'string' || !Number.isFinite(Date.parse(parsed[0]))) {
      return bail(400, 'invalid', 'cursor')
    }
    return parsed
  }

  async function handle(method: string, url: URL, headers: Headers, b: Record<string, unknown>): Promise<Response> {
    const p = url.pathname
    const slug = url.searchParams.get('appSlug') ?? b.appSlug

    // ---- directus-otp-auth (bearer transport) ----
    if (method === 'POST' && p === '/otp-auth/code') {
      const email = norm(b.email)
      if (b.appSlug === appSlug && users.has(email)) codes.set(email, o.fixedCode ?? String(Math.floor(Math.random() * 1e8)).padStart(8, '0'))
      return ok()
    }
    if (method === 'POST' && p === '/otp-auth/verify') {
      const email = norm(b.email)
      const code = codes.get(email)
      if (b.appSlug !== appSlug || !code || code !== b.code) return fail(401)
      codes.delete(email)
      const s: FakeSession = {
        id: crypto.randomUUID(), token: `${crypto.randomUUID()}.${pick(BASE62, 32)}`, userId: users.get(email)!.id, appSlug,
        deviceLabel: typeof b.deviceLabel === 'string' ? b.deviceLabel : null, userAgent: headers.get('user-agent'),
        expiresAt: now() + 30 * DAY, lastAccessAt: now(), revoked: false,
      }
      sessions.push(s)
      return ok({ token: s.token, expiresAt: iso(s.expiresAt) })
    }
    if (p.startsWith('/otp-auth/')) {
      if (slug !== undefined && slug !== '' && slug !== appSlug) return fail(400)
      const s = sessionOf(headers)
      if (!s || s === 'bad') return fail(401)
      if (method === 'GET' && p === '/otp-auth/session') return ok({ principal: { type: 'app_user', id: s.userId }, appSlug, expiresAt: iso(s.expiresAt) })
      if (method === 'POST' && p === '/otp-auth/logout') { s.revoked = true; return ok() }
      if (method === 'POST' && p === '/otp-auth/logout-all') {
        let revoked = 0
        for (const x of sessions) if (x.userId === s.userId && !x.revoked) { x.revoked = true; revoked++ }
        return ok({ revoked })
      }
      if (method === 'GET' && p === '/otp-auth/sessions') {
        return ok({
          sessions: sessions.filter((x) => x.userId === s.userId && !x.revoked && x.expiresAt > now()).map((x) => ({
            id: x.id, appSlug: x.appSlug, deviceLabel: x.deviceLabel, userAgent: x.userAgent, ip: null,
            lastAccessAt: iso(x.lastAccessAt), expiresAt: iso(x.expiresAt), current: x.id === s.id,
          })),
        })
      }
      const dm = /^\/otp-auth\/sessions\/([^/]+)$/.exec(p)
      if (method === 'DELETE' && dm) {
        const t = sessions.find((x) => x.id === decodeURIComponent(dm[1]!) && x.userId === s.userId && !x.revoked && x.expiresAt > now())
        if (!t) return fail(404)
        t.revoked = true
        return ok()
      }
      return fail(404)
    }

    // ---- ph gateway ----
    if (!p.startsWith('/ph/v1/')) return fail(404, 'not_found')
    if (slug !== appSlug) return fail(400, 'invalid', 'unknown_app')

    // No session read: a stale Authorization header is ignored here, as in production.
    if (method === 'POST' && p === '/ph/v1/enroll') {
      const email = norm(b.email)
      if (typeof b.email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) return fail(400, 'invalid', 'email')
      enroll(email)
      return ok()
    }
    if (method === 'GET' && p === '/ph/v1/public') {
      const kind = url.searchParams.get('kind')
      requireKind(kind)
      const cursor = decodeCursor(url.searchParams.get('cursor'), 3)
      const key = (s: FakeSave) => [iso(s.updatedAt), userById(s.userId)?.handle ?? '', s.externalId] as const
      const cmp = (a: readonly [string, string, string], z: readonly [string, string, string]) =>
        Date.parse(a[0]) - Date.parse(z[0]) || (a[1] < z[1] ? -1 : a[1] > z[1] ? 1 : 0) || (a[2] < z[2] ? -1 : a[2] > z[2] ? 1 : 0)
      const all = [...saves.values()].filter((s) => s.kind === kind && s.visibility === 'public' && userById(s.userId))
        .sort((a, z) => cmp(key(z), key(a)))
        .filter((s) => !cursor || cmp(key(s), cursor as [string, string, string]) < 0)
      const page = all.slice(0, PUBLIC_PAGE)
      const last = page.at(-1)
      return ok({
        items: page.map((s) => ({
          externalId: s.externalId, name: s.name, kind: s.kind, ownerHandle: userById(s.userId)?.handle ?? null, updatedAt: iso(s.updatedAt),
          shareCode: activeShareOf(s.userId, s.kind, s.externalId)?.code ?? null,
        })),
        next: all.length > PUBLIC_PAGE && last ? b64url(key(last)) : null,
      })
    }

    // Optional auth from here: a header that is present must verify.
    const sess = sessionOf(headers)
    if (sess === 'bad') return fail(401, 'unauthorized')

    let m: RegExpExecArray | null
    if ((m = /^\/ph\/v1\/shares\/([^/]+)$/.exec(p)) && method === 'GET') {
      const v = view(m[1]!)
      if (!v) return fail(404, 'not_found')
      const isOwner = !!sess && v.sh.userId === sess.userId
      const res = ok({
        share: {
          code: v.sh.code, appSlug, kind: v.sh.kind, payload: v.payload,
          owner: v.owner ? { handle: v.owner.handle } : null, visibility: v.visibility, isOwner,
          canEdit: isOwner || (v.visibility === 'link_edit' && !!sess),
          canFork: !!sess && !isOwner && v.visibility !== 'private',
          viewCount: v.sh.viewCount, createdAt: iso(v.sh.createdAt),
        },
      })
      // Counted after responding, and never for the owner.
      if (!isOwner) v.sh.viewCount++
      return res
    }
    if (method === 'POST' && p === '/ph/v1/shares') {
      const k = requireKind(b.kind)
      const kind = b.kind as string
      if (b.externalId !== undefined && b.payload !== undefined) return fail(400, 'invalid', 'mode')
      if (b.externalId !== undefined) {
        if (!sess) return fail(401, 'unauthorized')
        const externalId = requireExternalId(b.externalId)
        if (externalId.length > 64) return fail(400, 'invalid', 'externalId')
        if (typeof b.visibility !== 'string' || !SHARE_VIS.includes(b.visibility)) return fail(400, 'invalid', 'visibility')
        const save = saves.get(`${sess.userId}|${kind}|${externalId}`)
        if (!save) return fail(404, 'not_found')
        // Sharing is not an edit: visibility changes, updatedAt does not.
        save.visibility = b.visibility as Visibility
        return created(activeShareOf(sess.userId, kind, externalId) ?? newShare({ kind, userId: sess.userId, externalId, payload: null, revokeKey: null }))
      }
      if (k.anonymousShare === false) return fail(403, 'forbidden', 'anonymous_share_disabled')
      checkPayload(k, b.payload, !!sess)
      const revokeKey = pick(BASE62, 43)
      return created(newShare({ kind, userId: sess?.userId ?? null, externalId: null, payload: structuredClone(b.payload), revokeKey }), revokeKey)
    }
    if ((m = /^\/ph\/v1\/shares\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      if (!sess) return fail(401, 'unauthorized')
      const v = view(m[1]!)
      if (!v) return fail(404, 'not_found')
      const isOwner = v.sh.userId === sess.userId
      if (!isOwner && v.visibility !== 'link_edit') return fail(403, 'forbidden')
      checkPayload(requireKind(v.sh.kind), b.payload, true)
      if (v.save) {
        v.save.payload = b.payload
        v.save.updatedAt = Math.max(now(), v.save.updatedAt + 1)
      } else {
        if (!isOwner) return fail(404, 'not_found')
        v.sh.payload = b.payload
      }
      return ok()
    }
    if ((m = /^\/ph\/v1\/shares\/([^/]+)\/fork$/.exec(p)) && method === 'POST') {
      if (!sess) return fail(401, 'unauthorized')
      const externalId = requireExternalId(b.externalId)
      const name = text(b.name, NAME_MAX)
      if (!name) return fail(400, 'invalid', 'name')
      const v = view(m[1]!)
      if (!v) return fail(404, 'not_found')
      if (v.sh.userId === sess.userId || v.visibility === 'private') return fail(403, 'forbidden', 'not_forkable')
      const key = `${sess.userId}|${v.sh.kind}|${externalId}`
      if (saves.has(key)) return fail(409, 'conflict', 'exists')
      assertQuota(sess.userId)
      const t = now()
      const save: FakeSave = {
        id: crypto.randomUUID(), userId: sess.userId, kind: v.sh.kind, externalId, name,
        payload: structuredClone(v.payload), visibility: 'private', forkedFrom: v.sh.code, createdAt: t, updatedAt: t,
      }
      saves.set(key, save)
      return ok({ save: saveWire(save, true) })
    }
    if ((m = /^\/ph\/v1\/shares\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      const revokeKey = b.revokeKey
      if (revokeKey !== undefined && typeof revokeKey !== 'string') return fail(400, 'invalid', 'revokeKey')
      // No key: the creator's session is required. With a key: optional.
      if (revokeKey === undefined && !sess) return fail(401, 'unauthorized')
      // Any status: revoking twice is idempotent for whoever may revoke it.
      const sh = CODE_RE.test(m[1]!) ? shares.get(m[1]!) : undefined
      if (!sh) return fail(404, 'not_found')
      const byKey = typeof revokeKey === 'string' && revokeKey.length > 0 && revokeKey.length <= 256 && sh.revokeKey !== null && sh.revokeKey === revokeKey
      const byOwner = !!sess && sh.userId !== null && sh.userId === sess.userId
      if (!byKey && !byOwner) return fail(403, 'forbidden')
      sh.status = 'revoked'
      return ok()
    }

    // Everything below needs a session.
    if (!sess) return fail(401, 'unauthorized')
    const me = userById(sess.userId)
    if (!me) return fail(401, 'unauthorized')

    if (p === '/ph/v1/me' && method === 'GET') return ok({ user: userWire(me) })
    if (p === '/ph/v1/me' && method === 'PATCH') {
      /** undefined = leave alone; null or "" = clear; else trimmed text (me.ts optionalName). */
      const optionalName = (v: unknown, field: string): string | null | undefined => {
        if (v === undefined) return undefined
        if (v === null) return null
        if (typeof v !== 'string' || [...v.trim()].length > NAME_MAX) return bail(400, 'invalid', field)
        return v.trim() || null
      }
      const firstName = optionalName(b.firstName, 'firstName')
      const lastName = optionalName(b.lastName, 'lastName')
      if (typeof b.handle === 'string') {
        if ([...users.values()].some((u) => u.id !== me.id && u.handle.toLowerCase() === (b.handle as string).toLowerCase())) return fail(409, 'conflict', 'handle_taken')
        me.handle = b.handle
      }
      if (firstName !== undefined) me.firstName = firstName
      if (lastName !== undefined) me.lastName = lastName
      return ok({ user: userWire(me) })
    }
    if (p === '/ph/v1/saves' && method === 'GET') {
      const kind = url.searchParams.get('kind')
      if (kind !== null) requireKind(kind)
      const limit = pageLimit(url.searchParams.get('limit'))
      const cursor = decodeCursor(url.searchParams.get('cursor'), 2)
      if (cursor && (typeof cursor[1] !== 'string' || !UUID_RE.test(cursor[1]))) return fail(400, 'invalid', 'cursor')
      const after = (s: FakeSave) => !cursor || s.updatedAt < Date.parse(cursor[0] as string)
        || (s.updatedAt === Date.parse(cursor[0] as string) && s.id < (cursor[1] as string))
      const mine = [...saves.values()].filter((s) => s.userId === me.id && (kind === null || s.kind === kind) && after(s))
        .sort((a, z) => z.updatedAt - a.updatedAt || (z.id < a.id ? -1 : z.id > a.id ? 1 : 0))
      const page = mine.slice(0, limit)
      const last = page.at(-1)
      return ok({ items: page.map((s) => saveWire(s, false)), next: mine.length > limit && last ? b64url([iso(last.updatedAt), last.id]) : null })
    }
    if (p === '/ph/v1/saves' && method === 'POST') {
      const k = requireKind(b.kind)
      const kind = b.kind as string
      const externalId = requireExternalId(b.externalId)
      const name = text(b.name, NAME_MAX)
      if (!name) return fail(400, 'invalid', 'name')
      const visibility = optionalVisibility(b.visibility)
      let ifUpdatedAt: number | undefined
      if (b.ifUpdatedAt !== undefined && b.ifUpdatedAt !== null) {
        ifUpdatedAt = typeof b.ifUpdatedAt === 'string' && b.ifUpdatedAt.length > 0 ? Date.parse(b.ifUpdatedAt) : NaN
        if (!Number.isFinite(ifUpdatedAt)) return fail(400, 'invalid', 'ifUpdatedAt')
      }
      checkPayload(k, b.payload, true)
      const key = `${me.id}|${kind}|${externalId}`
      const ex = saves.get(key)
      // "The row I last saw": a different stored instant, or no row at all, is a conflict.
      if (ifUpdatedAt !== undefined && (!ex || ex.updatedAt !== ifUpdatedAt)) return fail(409, 'conflict')
      if (!ex) assertQuota(me.id)
      const t = now()
      const save: FakeSave = ex
        ? { ...ex, name, payload: b.payload, visibility: visibility ?? ex.visibility, updatedAt: Math.max(t, ex.updatedAt + 1) }
        : { id: crypto.randomUUID(), userId: me.id, kind, externalId, name, payload: b.payload, visibility: visibility ?? 'private', forkedFrom: null, createdAt: t, updatedAt: t }
      saves.set(key, save)
      return ok({ save: saveWire(save, true) })
    }
    if ((m = /^\/ph\/v1\/saves\/([^/]+)\/([^/]+)$/.exec(p))) {
      const kind = decodeURIComponent(m[1]!)
      requireKind(kind)
      const externalId = requireExternalId(decodeURIComponent(m[2]!))
      const key = `${me.id}|${kind}|${externalId}`
      const save = saves.get(key)
      if (method === 'GET') return save ? ok({ save: saveWire(save, true) }) : fail(404, 'not_found')
      if (method === 'PATCH') {
        const name = b.name === undefined ? undefined : text(b.name, NAME_MAX) ?? bail(400, 'invalid', 'name')
        const visibility = optionalVisibility(b.visibility)
        if (!save) return fail(404, 'not_found')
        if (name === undefined && visibility === undefined) return ok({ save: saveWire(save, true) })
        const next = { ...save, name: name ?? save.name, visibility: visibility ?? save.visibility, updatedAt: Math.max(now(), save.updatedAt + 1) }
        saves.set(key, next)
        return ok({ save: saveWire(next, true) })
      }
      if (method === 'DELETE') {
        if (!save) return fail(404, 'not_found')
        saves.delete(key)
        revokeSharesOf(me.id, kind, externalId)
        return ok()
      }
    }
    return fail(404, 'not_found')
  }

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    let body: Record<string, unknown> = {}
    if (typeof init.body === 'string' && init.body.length > 0) {
      try {
        const parsed: unknown = JSON.parse(init.body)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail(400, 'invalid', 'invalid_body')
        body = parsed as Record<string, unknown>
      } catch {
        return fail(400, 'invalid', 'invalid_body')
      }
    }
    const queued = failures.get(`${method} ${url.pathname}`)?.shift()
    if (queued) return queued()
    try {
      return await handle(method, url, headers, body)
    } catch (e) {
      if (e instanceof Fail) return e.res
      return fail(500, 'server')
    }
  }) as typeof fetch

  return {
    fetch: fetchImpl,
    users, saves, shares, sessions,
    lastCode: (email) => codes.get(norm(email)) ?? null,
    failNext(route, status, body = { ok: false }, headers = {}) {
      const q = failures.get(route) ?? []
      q.push(() => reply(status, body, headers))
      failures.set(route, q)
    },
    seedSave(email, s) {
      const u = enroll(norm(email))
      const t = now()
      const save: FakeSave = {
        id: crypto.randomUUID(), userId: u.id, kind: s.kind, externalId: s.externalId, name: s.name,
        payload: s.payload, visibility: s.visibility ?? 'private', forkedFrom: null, createdAt: t, updatedAt: t,
      }
      saves.set(`${u.id}|${s.kind}|${s.externalId}`, save)
      return save
    },
  }
}
