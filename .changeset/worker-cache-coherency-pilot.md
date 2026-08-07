---
'@cat-factory/caching': minor
'@cat-factory/orchestration': minor
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
- `@cat-factory/caching`: a coherent cache declares `cacheWideInvalidation` when its
  service calls `invalidateAll`; only those probe the reserved `'*'` epoch shard (one
  globally placed Durable Object), and an undeclared `invalidateAll` on a coherent cache
  throws rather than dropping entries locally while peers serve them to the TTL.
- `@cat-factory/caching`: new `currentInvocation` option for ISOLATE runtimes. Where it is
  supplied, a cache MISS (and a coherency probe) never joins an in-flight promise created
  by a different invocation, because Cloudflare destroys the joining invocation with an
  uncatchable "Cannot perform I/O on behalf of a different request"; coalescing within one
  invocation is unchanged, as is Node, which supplies nothing.
- `@cat-factory/worker`: new `CacheGenerationDirectory` sqlite Durable Object (migration
  tag v5) behind the OPTIONAL `CACHE_GENERATIONS` binding; the app-cache bag is now one
  per isolate (module scope) instead of one per invocation, with loader background work
  adopted onto the current invocation's `ctx.waitUntil` and per-invocation load scoping
  (above) via an ambient ExecutionContext.
  Deployers: add the binding + v5 migration (see `deploy/backend/wrangler.toml`) to turn
  the coherent profile on; without the wrangler edit the Worker keeps the previous
  pass-through behaviour.
- `@cat-factory/kernel` + `@cat-factory/observability-otel`: four new operational
  counters (`cache.coherency_probe`, `cache.coherency_invalidation`,
  `cache.coherency_probe_failure`, `cache.coherency_bump_failure`) with their OTel names
  and units.

Behaviour changes worth calling out beyond the Worker:

- `WorkspaceSettingsService.update` now reads its merge base from the repository instead of
  through the cache. It is a read-modify-write of the whole settings row, so a base stale by
  even one bounded-staleness window silently reverted a field a peer had committed inside it.
- On the ISOLATE profiles, `repoFiles` and `fragmentDocumentBody` widen their preemptive
  refresh window to cover the whole TTL. Their entries now live that full TTL across requests
  (the bag used to be rebuilt per invocation), and the claim that keeps them enabled on the
  Worker at all is that their probe bounds staleness, so the window has to be the lifetime.
- The coherent `workspaceSettings` entry carries a 60s TTL rather than the Node profile's five
  minutes: with bumps failing open, the TTL is the real bound when a bump fails, and that row
  carries `allowInitiatorPat`, `storeAgentContext` and the spend caps.
