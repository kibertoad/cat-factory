---
'@cat-factory/caching': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': patch
'@cat-factory/conformance': patch
'@cat-factory/local-server': patch
---

Caching initiative pilot (docs/initiatives/caching-layer.md, rows 0-1): introduce the
app-level caching seam and adopt it for the per-dispatch fragment-catalog resolve.

- New published package `@cat-factory/caching`: `createAppCaches(options)` builds the
  named, typed in-memory read-through caches (layered-loader `GroupLoader`, LRU + TTL)
  behind the new kernel `AppCaches`/`GroupCacheHandle` port. Redis is only ever an
  invalidation bus, never a data tier; with no notification factory injected the
  loaders are bare in-memory. The package deep-imports only layered-loader's in-memory
  machinery so ioredis never enters the module graph outside the Node facade's
  REDIS_URL-gated wiring.
- `FragmentLibraryService.resolveCatalog` now reads through the fragment-catalog cache
  (group = workspace id), and every fragment write path — create / update / remove /
  createFromDocument / refresh / the run-time document-body re-resolve / fragment-source
  sync + unlink — invalidates it after commit (`invalidateCatalogTier`). The
  `ResolvedCatalogEntry` type moved to `@cat-factory/kernel` so the port can name it.
- Node facade: `start()` builds the process-wide cache bag; when `REDIS_URL` is set,
  each cache gets its own `cat-factory:cache:<name>` notification channel (prefix
  overridable via the new `REDIS_CACHE_CHANNEL_PREFIX` env var) over dedicated
  ioredis publisher/subscriber clients, so peers drop their in-memory entries on every
  write — the same gating and resilience pattern as the realtime propagator. Local
  mode stays bare in-memory (single-node by construction).
- Cloudflare Worker: wired with the ISOLATE-SAFE profile — the fragment catalog (mutable
  cross-instance state) is pass-through, since an isolate has no cross-isolate
  invalidation bus. Documented in the caching package README.
- Conformance: new `defineCacheSuite` asserts write-then-read coherence of the resolved
  catalog on all three runtimes (Worker/Node/local).
- Staleness probes for the upcoming git-backed slices, on layered-loader 14.5.3's new
  in-memory `isEntryStillCurrentFn` support: a cache profile may set
  `ttlLeftBeforeRefreshInMsecs`, and `GroupCacheHandle.get` accepts an optional per-read
  `isStillCurrent` probe — entries entering the refresh window get their TTL bumped when
  the probe reports the source unmoved, and fall back to a full background reload
  otherwise. `layered-loader` (maintainer-owned) is now excluded unversioned from the
  `minimumReleaseAge` supply-chain gate, like the `@cat-factory/*` namespace.
