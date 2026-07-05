# @cat-factory/caching

## 0.4.0

### Minor Changes

- 1f6d9fc: Cache the workspace GitHub repo projection through the app caching seam
  (caching-layer initiative, slice 3). A new `AppCaches.repoProjection` group cache
  (grouped and keyed by workspace id) serves the whole-projection re-list that the
  block→repo resolver (`buildResolveRepoTarget`) runs on every agent dispatch and
  every durable poll tick, replacing a live `repoProjectionRepository.list` per
  resolution with a per-workspace cached read.

  Coherence is invalidation-driven: every projection write drops the workspace
  group after it commits — `GitHubSyncService` (repo link / monorepo-flag / the
  exact-set write + tombstone / the link-time full re-stamp, fanned out per
  workspace), `BoardService.addServiceFromRepo` (the monorepo-flag write on the
  import-existing-repo path), `WebhookService` (the `installation_repositories`
  removed tombstone), and `ContainerRepoBootstrapper` (projecting a freshly
  bootstrapped repo). `GitHubSyncService.syncRepo` only invalidates on a `full`
  (link-time) pass — an incremental resync re-stamps `syncedAt` alone, which the
  resolver never reads, so invalidating there would only churn the cache. The
  installation lookup and the tree-depth-bounded block ancestry walk stay live, so
  a block reparent or a service repo-link change needs no cache invalidation.

  The cache is pass-through on the Cloudflare Worker's isolate-safe profile (our own
  mutable D1 state, no cross-isolate invalidation bus), so the Worker reads the
  projection live. Local mode is likewise pass-through: it seeds the projection via
  the out-of-process `link-repo` CLI and runs single-node with no invalidation bus,
  so an in-memory TTL'd entry could serve a pre-link projection. So the cache is
  active on the multi-node-capable Node facade only. Absent a cache (tests /
  harnesses) every resolve lists live, unchanged.

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0

## 0.3.0

### Minor Changes

- e5ddaa4: Cache document-backed prompt-fragment bodies through the app caching seam
  (caching-layer initiative, slice 2). A new `AppCaches.fragmentDocumentBody`
  group cache serves a living fragment's external Confluence/Notion/GitHub/Figma/
  Zeplin/Linear body, replacing the hand-rolled `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`
  in `FragmentLibraryService`: a run reads the cached body instead of blocking on a
  live page fetch, and an entry entering its refresh window runs the source's cheap
  version probe — keeping the cached body when the page hasn't moved, reloading in
  the background when it has.

  To support the probe, `DocumentContent` now carries an opaque `version` token and
  `DocumentSourceProvider`/`DocumentContentResolver` gain a `probeVersion` method
  (metadata-only, strictly cheaper than a full fetch), implemented across all
  document providers. The self-verifying cache stays enabled on the Cloudflare
  Worker (bounded staleness via the probe), unlike the mutable-state fragment
  catalog.

  Behavior change (pre-1.0, no back-compat): the durable `prompt_fragments.body` is
  now the offline fallback + management-view content, refreshed only by an explicit
  create/refresh; the live run-time body flows through the cache. Without a cache
  wired, a run serves the persisted body and does not re-resolve live.

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.2.0

### Minor Changes

- 9bac054: Caching initiative pilot (docs/initiatives/caching-layer.md, rows 0-1): introduce the
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

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0
