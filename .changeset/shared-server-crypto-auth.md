---
'@cat-factory/server': minor
'@cat-factory/worker': patch
---

Move the runtime-neutral crypto/auth primitives into `@cat-factory/server`: the
base64url/PEM encoding helpers and the Web Crypto `HmacSigner` (with the token
audiences and session payload types) that mint and verify the session, OAuth
state, container-proxy and WebSocket-ticket tokens. These are pure Web Crypto, so
both the Cloudflare Worker and the upcoming Node service share one implementation.
The Worker re-exports them from their previous paths; behaviour is unchanged.
