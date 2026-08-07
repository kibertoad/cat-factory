---
'@cat-factory/caching': minor
'@cat-factory/kernel': minor
'@cat-factory/observability-otel': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': patch
---

Worker cache-coherency pilot on layered-loader 16.1: caches of our own mutable state can
now hold a real TTL on Cloudflare, with cross-isolate staleness bounded by a pull
generation probe instead of being indefinite.

- `@cat-factory/caching`: new `CacheGenerationStore` seam + `coherencyWindowMsecs` profile
  field (a probe of a shared per-(cache, group) generation directory before serving, with
  layered-loader 16.1's fencing `applyRemoteInvalidation*` applied on a moved counter, and
  a bump after every local invalidation; reads fail closed to pass-through, bumps fail
  open onto the TTL backstop). New `ISOLATE_COHERENT_APP_CACHES_PROFILE` flips
  `workspaceSettings` as the pilot. `scheduleBackgroundWork` is threaded to every loader.
  layered-loader bumped to ^16.1.0 (ESM package; also bumped in the Node facade).
- `@cat-factory/worker`: new `CacheGenerationDirectory` sqlite Durable Object (migration
  tag v5) behind the OPTIONAL `CACHE_GENERATIONS` binding; the app-cache bag is now one
  per isolate (module scope) instead of one per invocation, and loader background work is
  adopted onto the current invocation's `ctx.waitUntil` via an ambient ExecutionContext.
  Deployers: add the binding + v5 migration (see `deploy/backend/wrangler.toml`) to turn
  the coherent profile on; without the wrangler edit the Worker keeps the previous
  pass-through behaviour.
- `@cat-factory/kernel` + `@cat-factory/observability-otel`: four new operational
  counters (`cache.coherency_probe`, `cache.coherency_invalidation`,
  `cache.coherency_probe_failure`, `cache.coherency_bump_failure`) with their OTel names
  and units.
