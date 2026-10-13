// [GATED: needs gates 0.5 + 0.6 live] Saves and shares smoke against production
// (runbook 1.4): upsert, 409 on a stale ifUpdatedAt, owned share -> private -> null,
// anonymous share -> revoke with key -> null. Always cleans up (try/finally): removes
// its save, revokes both shares, signs out - each step best-effort.
// Never prints the code, token or revoke key.
// Run: PH_SMOKE_EMAIL=<test mailbox> npm run smoke:saves
import { createInterface } from 'node:readline/promises'
import { createPepperhornClient, memoryOtpFlow, memoryTokenStore } from '../src/index.js'

const email = process.env.PH_SMOKE_EMAIL
if (!email) throw new Error('Set PH_SMOKE_EMAIL to a mailbox you can read.')
const base = { appSlug: 'tickle-me-ivories', baseUrl: process.env.PH_BASE_URL ?? 'https://apps.pepperhorn.com' }
const owner = createPepperhornClient({ ...base, tokenStore: memoryTokenStore(), otpFlowStore: memoryOtpFlow(), deviceLabel: 'app-sdk smoke' })
const guest = createPepperhornClient({ ...base, tokenStore: memoryTokenStore(), otpFlowStore: memoryOtpFlow() })
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m) }

// Every step after sign-in runs inside try; finally undoes what was made, each
// step best-effort (a failed cleanup is reported but never hides the real error).
let savedId: string | null = null
let anonShare: { code: string; revokeKey: string | undefined } | null = null
let ownedCode: string | null = null
let signedIn = false
let failed = false
const cleanup = async (what: string, fn: () => Promise<unknown>) => {
  try { await fn() } catch (e) {
    const code = (e as { code?: string }).code
    if (code !== 'not_found') console.error(`cleanup: could not ${what} (${code ?? 'error'})`)
  }
}

try {
  await owner.auth.requestCode(email)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await owner.auth.verifyCode(email, (await rl.question('Code from the email: ')).trim())
  } finally {
    rl.close()
  }
  signedIn = true

  const look = { v: 1, kind: 'look', theme: { name: 'classic', stageBgOverride: null }, display: { mode: 'roll', fallSeconds: 3, settings: { zoom: 'full', showGrid: true, showFlash: true, flashScale: 1, showMiddleC: true } }, text: { labels: 'off', labelPlacement: 'above', chord: 'off', chordPlacement: 'stage-centre', chordAlternates: false, chordWindowMs: 250, keyOverride: null, style: { family: 'Poppins', weight: 600, sizeRatio: 0.5, letterSpacing: 0, color: '#ffffff', opacity: 1, strokeWidth: 3, strokeColor: 'rgba(0,0,0,0.35)' } }, velocity: { kind: 'lightness', lMax: 70, lMin: 35, sat: 80 } }
  const id = `smoke-${Date.now()}`
  const saved = await owner.saves.upsert({ kind: 'look', externalId: id, name: 'SDK smoke', payload: look })
  savedId = id
  try {
    await owner.saves.upsert({ kind: 'look', externalId: id, name: 'SDK smoke', payload: look, ifUpdatedAt: '2000-01-01T00:00:00.000Z' })
    throw new Error('a stale ifUpdatedAt was accepted')
  } catch (e) { assert((e as { code?: string }).code === 'conflict', `expected conflict, got ${String(e)}`) }
  assert((await owner.saves.get('look', id))?.updatedAt === saved.updatedAt, 'get did not return the save')

  const owned = await owner.shares.createFromSave({ kind: 'look', externalId: id, visibility: 'link_view' })
  ownedCode = owned.code
  assert(/^[A-Za-z0-9]{10}$/.test(owned.code), 'odd share code')
  console.log(`owned share made (short link ${owned.shortUrl ? 'present' : 'not yet'})`)
  assert(await guest.shares.resolve(owned.code), 'guest could not resolve the owned share')
  await owner.saves.setVisibility('look', id, 'private')
  assert((await guest.shares.resolve(owned.code)) === null, 'a private save still resolved')

  const anon = await guest.shares.createAnonymous({ kind: 'look', payload: look })
  anonShare = { code: anon.code, revokeKey: anon.revokeKey }
  await guest.shares.revoke(anon.code, anon.revokeKey)
  anonShare = null
  assert((await guest.shares.resolve(anon.code)) === null, 'a revoked anonymous share still resolved')

  await owner.saves.remove('look', id)
  savedId = null
  console.log('smoke-saves PASS')
} catch (e) {
  failed = true
  console.error(`smoke-saves FAIL: ${e instanceof Error ? e.message : 'error'}`)
} finally {
  const anonLeft = anonShare
  const ownedLeft = ownedCode
  const savedLeft = savedId
  if (savedLeft) await cleanup('remove the smoke save', () => owner.saves.remove('look', savedLeft))
  if (anonLeft) await cleanup('revoke the anonymous share', () => guest.shares.revoke(anonLeft.code, anonLeft.revokeKey))
  // Ends the owned link even when the run stopped before it went private (not_found is fine).
  if (ownedLeft && signedIn) await cleanup('revoke the owned share', () => owner.shares.revoke(ownedLeft))
  if (signedIn) await cleanup('sign out', () => owner.auth.signOut())
}
process.exit(failed ? 1 : 0) // like smoke-auth: a client may leave a retry timer behind
