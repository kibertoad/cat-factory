---
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Cap concurrent inline (non-container) LLM calls to a subscription/shared-pool vendor so a burst
can't overwhelm it. A new `VendorConcurrencyLimiter` + `LimitedModelProvider` decorator
(`@cat-factory/agents`) gates each resolved subscription-vendor model behind an in-process
per-vendor semaphore, keyed by `subscriptionVendorForRef(ref)`. It is applied as the outermost
resolver wrap in every facade via `wrapResolverWithLimiter` (`@cat-factory/server`), mirroring the
existing `InstrumentedModelProvider` shape, so no inline call site changes. Both the buffered
(`wrapGenerate`) and streaming (`wrapStream`) inline paths are gated — a stream holds its permit
until it ends — and a queued call whose request is aborted releases its slot instead of
head-of-line blocking. Only the five subscription vendors (`claude`/`codex`/`glm`/`kimi`/`deepseek`)
are capped; API-key vendors and Cloudflare pass through untouched.

Configured by `LLM_SUBSCRIPTION_MAX_CONCURRENCY` (default 3 per vendor; a
`LLM_SUBSCRIPTION_MAX_CONCURRENCY_<VENDOR>` overrides that one vendor and always wins). Any value
`<= 0` is uncapped, so setting the default to `0` uncaps every vendor that has no explicit
per-vendor override (to turn the feature off entirely, leave the per-vendor overrides unset too).
The limiter is
in-process only — one per Node process (per container/tenant) or per Worker isolate, which is the
scope of a single inline fan-out (a consensus panel, the requirements recommendation writer, a
sandbox sweep). It bounds in-flight concurrency, not requests-per-minute, and does not coordinate
across replicas/isolates; global rate-limiting stays out of scope. Because inline subscription
refs are degraded to a pool/API-key provider before resolve on Node/Worker, the cap primarily
bites in local mode (the prewarmed-container inline subscription backend keeps the ref) and is a
wired pass-through elsewhere.
