---
'@cat-factory/server': minor
'@cat-factory/worker': patch
---

Introduce `@cat-factory/server`, the runtime-neutral HTTP layer shared by every
deployment facade. This first slice moves the cross-cutting HTTP primitives out of
the Cloudflare Worker — structured logging, the path-param helper, the valibot
request-body validation envelope, the domain→HTTP error mapping, and the CORS
origin policy — so they can be reused by a non-Worker (Node) facade. The Worker
re-exports them from their previous paths, so behaviour is unchanged.
