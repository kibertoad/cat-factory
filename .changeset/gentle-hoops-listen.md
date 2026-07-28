---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Error identity now survives the trip from where a failure happens to where a user reads it.

A run that dies on a thrown error carries that error's machine-readable `details.reason` onto
its `AgentFailure` on both runtimes — previously the Cloudflare driver dropped `reason` on every
path (and the container post-mortem `detail` on evictions), so the SPA's remedies could never
fire in production. The wire vocabulary gains `UnavailableError` (503), `UnauthorizedError`
(401) and `RateLimitedError` (429), and the 113 hand-rolled error envelopes across the HTTP
layer are migrated onto it, so a 503/401/429 can now carry a `reason` code at all.

Breaking (pre-1.0, no migration): `POST /signup` now answers 409 (`conflict`) for an
already-registered email and 422 (`validation`) for a rejected password, instead of flattening
both onto 400. The LLM proxy no longer returns the raw upstream exception text on a failed
in-process call, and every proxy error envelope now carries a `code`.

Privacy fix: inline (non-proxied) LLM calls now honour the per-workspace `storeAgentContext`
opt-out before shipping prompt/response bodies to an external trace sink, matching the proxied
path. A workspace that had opted out was still exporting its inline bodies to Langfuse/OTel.
