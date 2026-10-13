// [GATED: needs gates 0.5 + 0.6 live] Live sign-in smoke against production.
// A human types the mailed code. Never prints the code or the token.
// Run: PH_SMOKE_EMAIL=<test mailbox> npm run smoke:auth
import { createInterface } from 'node:readline/promises'
import { createPepperhornClient, memoryOtpFlow, memoryTokenStore } from '../src/index.js'

const email = process.env.PH_SMOKE_EMAIL
if (!email) throw new Error('Set PH_SMOKE_EMAIL to a mailbox you can read.')
const base = { appSlug: 'tickle-me-ivories', baseUrl: process.env.PH_BASE_URL ?? 'https://apps.pepperhorn.com' }
const tokens = memoryTokenStore()
const client = createPepperhornClient({ ...base, tokenStore: tokens, otpFlowStore: memoryOtpFlow(), deviceLabel: 'app-sdk smoke' })
await client.auth.requestCode(email)
const rl = createInterface({ input: process.stdin, output: process.stdout })
const code = (await rl.question('Code from the email: ')).trim()
rl.close()
const user = await client.auth.verifyCode(email, code)
console.log(`signed in as @${user.handle}`)
const devices = await client.auth.devices()
const current = devices.find((d) => d.current)
if (!current) throw new Error('the device list has no current session')
console.log(`devices: ${devices.length}`)

// revoking the current device clears the local token, so restore() on the same
// client would report signed-out without asking the server. Probe from a second
// client holding a copy of the token instead.
const token = tokens.get()
if (!token) throw new Error('no token after sign-in')
const probeWithCopy = () => {
  const copy = memoryTokenStore()
  copy.set(token, new Date(Date.now() + 60 * 60 * 1000).toISOString())
  return createPepperhornClient({ ...base, tokenStore: copy, otpFlowStore: memoryOtpFlow() })
}
const before = await probeWithCopy().auth.restore()
if (before.status !== 'signed-in') throw new Error(`the token copy should be accepted before revoking, got ${before.status}`)
await client.auth.revokeDevice(current.id)
const after = await probeWithCopy().auth.restore()
if (after.status !== 'signed-out') throw new Error(`the server still accepts a revoked session (${after.status})`)
console.log('smoke-auth PASS')
process.exit(0) // a probe restore may leave a retry timer behind
