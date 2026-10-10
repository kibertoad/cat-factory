# @cat-factory/webhooks

Verify a cat-factory outbound webhook delivery before trusting it. Every delivery the platform
sends (notifications, run lifecycle, platform health, directory changes) carries
`x-cat-factory-timestamp` and `x-cat-factory-signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.

```ts
import { verifyRequest } from '@cat-factory/webhooks'

const verdict = await verifyRequest(request, process.env.WEBHOOK_SECRET!)
if (!verdict.ok) return new Response(verdict.reason, { status: 401 })
const delivery = JSON.parse(verdict.rawBody)
```

`verifyDelivery(headers, rawBody, secret, now)` is the same check for a framework that hands you
the headers and the raw body separately. Both verify the exact bytes received, compare in constant
time, and refuse a timestamp outside a 5-minute window (configurable), so a captured delivery cannot
be replayed later. Web Crypto only: it runs on Node 20+, in browsers and in worker isolates.
