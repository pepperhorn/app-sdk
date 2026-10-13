# @pepperhorn/app-sdk

The PepperHorn client for apps: email one-time-code sign-in, named saves and share links, against `https://apps.pepperhorn.com`. MIT. It holds no secrets; every check runs on the server.

```ts
import { createPepperhornClient } from '@pepperhorn/app-sdk'

const ph = createPepperhornClient({ appSlug: 'my-app' })
await ph.auth.restore()
await ph.auth.requestCode('me@example.com')
await ph.auth.verifyCode('me@example.com', '12345678')
await ph.saves.upsert({ kind: 'preset', externalId: crypto.randomUUID(), name: 'Mine', payload: {} })
```

- `@pepperhorn/app-sdk/react`: `PhProvider`, `useAuth`, `useSaves`, `useShareFromUrl`.
- `@pepperhorn/app-sdk/ui`: headless `useOtpForm` and `OtpDigits` (class hooks `.ph-otp-form`, `.ph-otp-digit`).
- `@pepperhorn/app-sdk/testing`: an in-memory fake of the PepperHorn endpoints for tests.

Peer dependencies: `zod >=3.25 <5` (imported as `zod/v4`), and `react >=19` for the React entries only.

## Server requirements

The SDK signs in with a bearer token, not a cookie. The PepperHorn server must run with `OTP_AUTH_TRANSPORT` set to `bearer` or `both`; with a cookie-only transport, sign-in will not return a token and the SDK cannot restore a session.
