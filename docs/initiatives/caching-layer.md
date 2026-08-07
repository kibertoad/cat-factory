# Initiative: caching layer (layered-loader, in-memory + Redis-notified invalidation)

**Status:** in progress: pilot (row 0) + slices 1–4, 9–11 landed · **Owner:** core ·
**Started:** 2026-07-04

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

The backend re-reads the same slow-moving data over and over on its hottest paths, with no
shared caching abstraction:

- **Per agent dispatch** (and again on every `RunDispatcher` poll tick that re-enters
  context assembly): `FragmentLibraryService.resolveCatalog` re-merges the tenant fragment
  catalog from `prompt_fragments` (`listByOwner('account')` + `listByOwner('workspace')` +
  `workspaces.accountOf`), `resolveRepoTarget` re-lists the whole `github_repos` projection
  and walks the block ancestry, and `AgentContextBuilder` re-reads reviews/docs per block.
- **Per repo-op**: `blueprintPostOp`/`specPostOp` issue many `RepoFiles.getFile` /
  `listDirectory` calls against the same branch for idempotency byte-compares; live GitHub
  contents-API round-trips every run.
- **Per request**: the per-workspace `GET /models` + `resolveWorkspaceCapabilities`
  recompute provider/key/subscription capability sets on every call.

Where caching does exist it is hand-rolled and instance-local: `GitHubAppAuth`'s module
`tokenCache` Map, `LocalSettingsService`'s 5s TTL cache, the fragment library's bespoke
5-minute doc-fragment TTL (`DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`). None of these invalidate
across replicas, so a horizontally-scaled Node deployment serves stale data for the TTL
window after any write: the same class of gap the realtime `WebSocketPropagator` work
closed for events.

The fix: **one caching seam built on [`layered-loader`](https://github.com/kibertoad/layered-loader)**:

- **In-memory cache only** (`inMemoryCache`, no `RedisCache` async layer). Each replica
  holds its own LRU and repopulates from its data source on miss; Redis is **never a data
  tier**.
- **Distributed invalidation via the Redis notification pair** (`createNotificationPair` /
  `createGroupNotificationPair`) in **non-local mode**: a write on one node calls
  `invalidateCacheFor(key)`, layered-loader publishes the key on the channel, every peer
  drops its in-memory entry. Gated on `REDIS_URL` exactly like the realtime propagator;
  absent (single replica, and local mode, which is always single-node) the loaders are
  bare in-memory with zero extra dependency.
- **Staleness checker (`isEntryStillCurrentFn`) for git-backed sources**: entries entering
  the `ttlLeftBeforeRefreshInMsecs` window run a cheap probe (commit-sha / head-sha /
  content-hash compare) and get their TTL bumped when nothing changed, instead of
  refetching + re-rendering full content. This replaces the hand-rolled sha-probe patterns
  (`FragmentSourceService.status`, the doc-fragment TTL) with the library primitive.

## Deviations proven by the pilot (read before the next slice)

The pilot validated the pattern below with four corrections a later slice must carry:

- **layered-loader's ROOT index re-exports its Redis surface, so "ioredis stays out" is
  enforced at the _module graph_, not the install.** Since layered-loader 16 the package
  states that boundary itself: `@cat-factory/caching` imports `layered-loader/core`, the
  Redis-free entrypoint (safe in workerd, proven by the Worker conformance run), and only
  the Node facade's `REDIS_URL`-gated dynamic import (`cacheNotifications.ts`) reaches
  `layered-loader/redis` for `createGroupNotificationPair`. Never import the package ROOT
  from `@cat-factory/caching`: it carries both halves. (Through 15.x this had to be spelled
  as deep imports into `dist/`, which 15's `exports` map then forbade; 16 also demotes
  `ioredis` to an optional peer resolved lazily, and only when a caller passes connection
  options rather than a client: we always pass clients.)
- **The consumer-facing interfaces live in kernel** (`ports/caching.ts`: `AppCaches`,
  `GroupCacheHandle`), per the repo's ports-in-kernel rule, so services (agents) depend
  on no caching machinery; `@cat-factory/caching` is the implementation the composition
  roots build. `ResolvedCatalogEntry` moved to kernel so the port can name it. The handle's
  `get(key, group, load)` carries the load closure per call (the owning service keeps its
  load logic; the loader keeps in-flight dedup), no late-bound data-source binding.
- **Slice 1 keys by `workspaceId` alone (not `(accountId, workspaceId)`)**: the account is
  resolved inside the load, so a cache hit costs ZERO reads (an accountId-bearing key would
  re-read `accountOf` on every hit); a workspace never changes accounts. Account-tier
  writes invalidate via the coarse `invalidateAll()` (rare management actions; enumerating
  the account's workspaces would need a new `WorkspaceRepository` port method whose only
  consumer is invalidation: over-invalidation is safe and cheaper).
- **The in-memory staleness probe is fully supported since layered-loader `14.5.3`**
  (upstreamed per `docs/proposals/layered-loader-in-memory-staleness-probe.md`; earlier
  14.5.x hard-gated `isEntryStillCurrentFn` on an async cache tier). The seam exposes it
  ready for slices 2/4: a cache profile sets `ttlLeftBeforeRefreshInMsecs`, and the OWNING
  service passes its cheap probe per read (`handle.get(key, group, load, isStillCurrent)`
  ) mirroring how the load closure rides the read. An entry hit inside the window probes in
  the background: TTL bump on `true` (no refetch), full background reload on `false`/throw,
  and a read that passes no probe (or a profile with no window) degrades to the blind
  background reload. Covered by the caching package's probe tests. Note `layered-loader` is
  listed (unversioned) in `minimumReleaseAgeExclude`: it is maintainer-owned, same trust
  class as `@cat-factory/*`, so releases like 14.5.3 install without waiting out the
  supply-chain age gate.
- **CI has no Redis service**, so the notification path is covered by fake-bus tests: the
  caching package's two-`AppCaches` test (fake publisher/consumer pair) and
  `runtimes/node/test/cacheNotifications.spec.ts`, which drives the REAL layered-loader
  Redis notification classes (envelope, echo suppression, per-cache channels) over
  injected fake ioredis clients; the `propagator.spec.ts` pattern. The tracker's
  real-ioredis integration test stays open until CI gains a Redis service.

## Target pattern (to be proven by the pilot)

The realtime propagator (`backend/runtimes/node/src/propagator.ts` +
`redisPropagator.ts`, initiative `redis-websocket-propagation`) is the wiring blueprint;
the registry-DI initiative supplies the ownership rule (composition root owns the
instances, no module globals).

1. **New published package `backend/packages/caching` (`@cat-factory/caching`)** wrapping
   `layered-loader` (regular dependency; `ioredis` stays out: see below):
   - **`AppCaches`**; the app-owned bag of _named, typed_ `Loader`/`GroupLoader`/`ManualCache`
     instances (one per checklist row below), created by **`createAppCaches(options)`**.
     Workspace-scoped caches are `GroupLoader`s grouped by `workspaceId` so a
     workspace-wide event (e.g. a GitHub sync) is one `invalidateCacheForGroup` call.
   - **Per-cache config profile**: `cacheType: 'lru-object'`, explicit `ttlInMsecs` +
     `maxItems` per cache, `ttlLeftBeforeRefreshInMsecs` + `isEntryStillCurrentFn` only on
     the git-backed caches. A facade passes a profile so TTLs can differ per runtime.
   - `options.notificationPairFactory?`: an injected factory returning
     `{ publisher, consumer }` per cache channel; absent ⇒ bare in-memory loaders.
2. **Redis notification wiring lives in the Node facade**, mirroring
   `redisPropagator.ts` verbatim: a `buildCacheNotifications(env, log)` helper in
   `backend/runtimes/node` that is a no-op unless **`REDIS_URL`** is set, dynamically
   `await import('ioredis' as string)` (the cast keeps it out of the TS build graph;
   `ioredis` remains an `optionalDependencies` entry of `@cat-factory/node-server` only),
   builds the dedicated publisher/subscriber client pair with the same resilience options
   (`enableOfflineQueue`/`maxRetriesPerRequest` split, error handlers attached at
   construction, non-awaited subscribe, graceful `quit()`), on channel(s)
   `cat-factory:cache[:<cacheName>]` (override: `REDIS_CACHE_CHANNEL_PREFIX`).
3. **Injection through the existing seams**: `createAppCaches` is called once per process;
   Node `start()` (next to `buildRealtimePropagator`) threading the result through a new
   optional `caches?: AppCaches` field on `NodeContainerOptions` → `CoreDependencies`;
   consuming services take their loader off the single `dependencies` object. Absent ⇒
   the container builds bare in-memory defaults, so tests/harnesses don't change.
   `buildLocalContainer` inherits automatically (and never wires notifications: local is
   single-node by construction).
4. **Cloudflare Worker**: builds the bag ONCE per isolate (`appCachesHost.ts`) and picks
   its profile by the `CACHE_GENERATIONS` Durable Object binding. Bound ⇒ the
   **isolate-coherent profile** (slice 11): caches it names keep a real TTL and
   pull-probe a per-group generation directory on a short window, applying
   layered-loader 16.1's local `applyRemoteInvalidation*` primitives on a moved counter;
   every invalidation site bumps the directory after its local invalidation. Unbound ⇒
   the **isolate-safe profile**: caches of mutable cross-instance state are pass-through
   (`enabled: false`), and only immutable or self-verifying entries (sha-pinned
   `RepoFiles` reads, probe-validated documents) get real TTLs. PUSH invalidation stays
   a genuine Node-only concern (an isolate can hold no subscription); the Worker's
   answer is pull, and its staleness bound is the probe window rather than a bus.
   Documented in the package README.
5. **Invalidation discipline**: every write path that mutates a cached source calls the
   cache's `invalidateCacheFor`/`invalidateCacheForMany`/group variant **after the DB
   write commits** (layered-loader then publishes to peers automatically). The checklist
   row for each cache names its invalidation sites; a slice is not done until all of them
   are wired.
6. **Conformance**: add a standalone `defineCacheSuite` in `backend/internal/conformance`
   (mirroring `agent-context-suite.ts`) asserting write-then-read coherence through the
   cached path (mutate → immediately read → fresh value) on every runtime, plus a
   two-`AppCaches`-instances test in the caching package that drives the notification pair
   through an injected fake pub/sub (the `RedisWebSocketPropagator` tests' fake-client
   pattern) and a real-ioredis integration test in the Node runtime suite.
7. **Publish contract**: the new package needs the full checklist from CLAUDE.md ("Adding
   a new published package"); `prepublishOnly`, `files: ["dist"]`, registration in
   `backend/tsconfig.build.json` `references`, an initial-release changeset.

### Staleness-checker usage (the `isEntryStillCurrentFn` cases)

Only for caches whose source has a **cheap version probe** that is much cheaper than the
full load; the probe runs when an entry enters the refresh window and bumps TTL on `true`:

| Cache                         | Probe                                                             | Full load it avoids                                                        |
| ----------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Doc-backed fragment bodies ✅ | provider `probeVersion` token vs cached `DocumentContent.version` | full `DocumentContentResolver.fetch` (body download + Markdown conversion) |
| `RepoFiles` branch-ref reads  | `headSha(branch)` compare vs the sha the entry was read at        | per-file contents-API refetch                                              |

(The "Fragment-source git dirs" / "GitHub docs source reads" probe rows from the original
plan are folded away: the git fragment-source `status()` caching was dropped, per the
slice-2 findings below, and the GitHub-docs case IS the doc-backed row above; GitHub docs
are one of the `DocumentSourceProvider`s, probed via `latestCommitSha`.)

Sha-**pinned** reads (`getFile(path, <sha>)`) are immutable: long TTL, no checker needed.
DB-backed caches (fragment catalog, repo projection, presets, capabilities) do **not** use
the checker: they are invalidation-driven (a DB read as a probe saves nothing over the DB
read as the load).

## Per-cache checklist

Phase 0 is the pilot and lands the machinery; every later row is "adopt the seam for one
target + wire ALL its invalidation sites + tests" and should be a small PR.

| #   | Slice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Key files today                                                                                                                                                                                                                        | Cache key / group                                             | Invalidated by                                                                                                                                                   | Staleness checker                                                      | Status                          | PR                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| 0   | **Pilot: `@cat-factory/caching` + notification wiring + seams + conformance suite** (target pattern §1–§7, with slice 1 as the proving consumer; real-ioredis CI test still open, no Redis service in CI)                                                                                                                                                                                                                                                                                                                                                                          | new package; `runtimes/node/src/server.ts`, `container.ts`, `cacheNotifications.ts`; `runtimes/cloudflare/.../container.ts`; `internal/conformance/src/cache-suite.ts`; kernel `ports/caching.ts`                                      | —                                                             | —                                                                                                                                                                | —                                                                      | ✅ done                         | [#767](https://github.com/kibertoad/cat-factory/pull/767) |
| 1   | **Fragment catalog**; `FragmentLibraryService.resolveCatalog` (per-dispatch tenant merge)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `agents/src/fragmentLibrary/FragmentLibraryService.ts`                                                                                                                                                                                 | group `workspaceId`, key `workspaceId` (see pilot deviations) | fragment `create`/`update`/`remove`/`createFromDocument`/`refresh` + the run-time document-body re-resolve; `FragmentSourceService.sync`/`unlink`                | no                                                                     | ✅ done                         | [#767](https://github.com/kibertoad/cat-factory/pull/767) |
| 2   | **Doc-backed fragment bodies**; replace `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS` with the `fragmentDocumentBody` loader + version probe. (The git fragment-source `status()` half was evaluated and **dropped**: see the conventions note; it's a cold, must-be-live UI action with no hot read path to cache.)                                                                                                                                                                                                                                                                          | `agents/src/fragmentLibrary/FragmentLibraryService.ts`; `kernel/ports/{document-source,caching}.ts`; `caching/src/appCaches.ts`; `integrations/.../documents/*Provider.ts`                                                             | group `viaWorkspaceId`, key `<source>:<externalId>`           | fragment `create`/`refresh`/`update`/`remove` (best-effort; the version probe bounds staleness regardless)                                                       | **yes** (provider `version` token vs cached `DocumentContent.version`) | ✅ done                         | [#782](https://github.com/kibertoad/cat-factory/pull/782) |
| 3   | **Repo projection**: `repoProjectionRepository.list` (per dispatch, per poll tick). Caches the whole-projection re-list only; the installation lookup + tree-depth-bounded ancestry walk stay live (so reparent/service-link need no invalidation). See the slice-3 findings.                                                                                                                                                                                                                                                                                                      | `server/src/agents/resolveRepoTarget.ts`, `ContainerRepoBootstrapper.ts`; `integrations/.../github/{GitHubSyncService,WebhookService}.ts`; `orchestration/src/container.ts`                                                            | group `workspaceId`, key `workspaceId`                        | `GitHubSyncService` link/monorepo/setLinkedRepos/syncRepo + `WebhookService` installation-removed tombstone + `ContainerRepoBootstrapper` project                | no                                                                     | ✅ done                         | [#789](https://github.com/kibertoad/cat-factory/pull/789) |
| 4   | **`RepoFiles.getFile`/`listDirectory`**: repo-op idempotency re-reads (`blueprintPostOp`, `specPostOp`). Cached ONLY on the `makeResolveRunRepoContext` (pre/post-op) path; the environments repo-validation + doc-quality reads stay live. See the slice-4 findings.                                                                                                                                                                                                                                                                                                              | `kernel/ports/caching.ts`; `caching/src/appCaches.ts`; `server/src/agents/repoFiles.ts`; `integrations/.../github/WebhookService.ts`; runtime facades                                                                                  | group `<inst>:<owner>/<repo>@<branch>`, key `f:`/`d:` + path  | own `commitFiles` (self-invalidate the branch group); `WebhookService` push (a branch moved out-of-band)                                                         | **yes** for branch refs (`headSha`); pinned shas immutable             | ✅ done                         | [#875](https://github.com/kibertoad/cat-factory/pull/875) |
| 5   | **Workspace capabilities + per-workspace `GET /models`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `server/src/agents/providerCapabilities.ts`; `ModelController.ts`                                                                                                                                                                      | `(workspaceId, userId)`                                       | API-key / subscription / local-endpoint / OpenRouter-catalog writes                                                                                              | no                                                                     | ⬜ todo                         |                                                           |
| 6   | **`LocalSettingsService`**: migrate the bespoke 5s cache (multi-replica correctness win: today a peer serves stale settings for the TTL)                                                                                                                                                                                                                                                                                                                                                                                                                                           | `integrations/src/modules/localSettings/LocalSettingsService.ts`                                                                                                                                                                       | singleton key                                                 | `write()`                                                                                                                                                        | no                                                                     | ⬜ todo                         |                                                           |
| 7   | **`GitHubAppAuth` token cache**; migrate the module `tokenCache` Map to a `ManualCache` (hygiene: TTL from `expiresAt`; NO notifications; tokens are per-process, never broadcast, and notifications carry keys only anyway)                                                                                                                                                                                                                                                                                                                                                       | `server/src/github/GitHubAppAuth.ts`                                                                                                                                                                                                   | `installationId`                                              | expiry only                                                                                                                                                      | no                                                                     | ⬜ todo                         |                                                           |
| 8   | **Evaluate, don't assume**: workspace snapshot sub-reads, `requirementReviews.getByBlock` / linked docs in `buildAgentContext`, merge presets, OpenRouter catalog                                                                                                                                                                                                                                                                                                                                                                                                                  | `WorkspaceService.snapshot`; `AgentContextBuilder.ts`; `MergePresetService.ts`                                                                                                                                                         | —                                                             | —                                                                                                                                                                | —                                                                      | ⬜ decide per-item when reached |                                                           |
| 9   | **Viewer PAT repos**; `GitHubSyncService.viewerPatRepos` `/user/repos` enumeration (add-service picker typeahead, re-run per keystroke). Caches ONLY the query (typeahead) path so a keystroke filters a cached complete set in memory; the blank browse-all + its access-projection refresh stay live. The cold walk is also parallelized in `FetchGitHubClient.listReposForToken` (page 1's `rel="last"` → concurrent trailing pages). Pass-through on the Worker (external, not self-verifying).                                                                                | `kernel/ports/caching.ts`; `caching/src/appCaches.ts`; `integrations/.../github/{GitHubSyncService,providers/UserSecretService}.ts`; `server/src/github/FetchGitHubClient.ts`; `orchestration/src/container.ts` + runtime facades      | group `userId`, key `userId`                                  | `UserSecretService` `store`/`remove` of `github_pat` (a PAT swap changes what the key resolves to); the short 60s TTL backstops repos created straight on GitHub | no (short TTL: external state we never write)                          | ✅ done                         |                                                           |
| 10  | **Local-mode PAT installation repos**: the slice-9 fix for the WORKSPACE-credential branch: local mode's `PatGitHubClient.searchInstallationRepos` (the picker typeahead's app-side lookup when `GITHUB_PAT` backs the client) re-walked `/user/repos` serially + uncached per keystroke. The walk now delegates to `listReposForToken` (concurrent trailing pages) and the query path reads through the cache; browse-all (`listInstallationRepos` callers) stays live. No swap-invalidation: the local PAT is env-fixed per boot, so the short TTL is the whole coherence story. | `kernel/ports/caching.ts`; `caching/src/appCaches.ts`; `runtimes/local/src/{github,container}.ts`                                                                                                                                      | group `installationId`, key `installationId`                  | nothing (env-fixed credential; the 60s TTL backstops repos created straight on GitHub)                                                                           | no (short TTL: external state we never write)                          | ✅ done                         |                                                           |
| 11  | **Worker pull-coherency pilot**: layered-loader ^16.1.0, the `generationStore` seam + `coherencyWindowMsecs` profile field + `GroupGenerationTracker` in `@cat-factory/caching`, the `CacheGenerationDirectory` Durable Object (v5 migration, `CACHE_GENERATIONS` binding), the module-scope Worker bag (`appCachesHost.ts`) + ambient-ExecutionContext `scheduleBackgroundWork`, and the `workspaceSettings` flip on the new isolate-coherent profile. See the slice-11 findings.                                                                                                 | `caching/src/{appCaches,generationCoherency}.ts`; `kernel/ports/operational-metrics.ts`; `runtimes/cloudflare/src/infrastructure/{appCachesHost,requestContext,durable-objects/CacheGenerationDirectory}.ts`; both wrangler.toml files | group `workspaceId`, key `workspaceId` (pilot cache)          | `WorkspaceSettingsService.update` (sole site), now bumping the generation directory after the local drop                                                         | pull generation probe (5s window)                                      | ✅ done                         |                                                           |

## Conventions & gotchas (carry between iterations)

- **Redis is an invalidation bus, never a data tier.** No `RedisCache` async layer, no
  values on the wire: only keys/groups. A replica always repopulates from its own data
  source. If someone proposes adding the async tier, that's a new initiative.
- **Gate on `REDIS_URL`, mirror the propagator, keep `ioredis` optional.** Dynamic
  `import('ioredis' as string)`, `optionalDependencies` in the Node facade only, dedicated
  publisher + subscriber clients (a subscribed connection can't issue commands), error
  handlers attached synchronously, don't await `subscribe` at boot, graceful `quit()` with
  `disconnect()` fallback. Do NOT share the realtime propagator's clients: separate
  concern, separate channel; consolidating a shared Redis connection factory is allowed
  later but is not this initiative's job.
- **Local mode never wires notifications.** It's single-node by construction
  (`runtimes/local/src/server.ts` passes the bare hub for realtime; caches follow the same
  rule). Bare in-memory loaders are the correct local configuration, not a degraded one.
- **Worker = pass-through OR generation-probed, never a bare TTL over mutable state.** A
  cache of our own mutable state may hold a real TTL on the Worker ONLY with a
  `coherencyWindowMsecs` on the coherent profile (slice 11's generation directory bounds
  its cross-isolate staleness at the window); `createAppCaches` refuses a window with no
  `generationStore` wired, and everything else mutable stays pass-through. A TTL with
  neither is the correctness bug this rule has always banned.
- **Invalidate after commit, at every write site.** Enumerate the write paths per slice
  (the checklist's "invalidated by" column) before coding; a missed site is a stale-read
  bug that only shows up multi-replica. Webhook-driven sources must invalidate from the
  webhook ingest path too.
- **`isEntryStillCurrentFn` runs only in the refresh window** (`ttlLeftBeforeRefreshInMsecs`):
  it does not guard normal cache hits. Size TTL vs window accordingly: the freshness
  guarantee between probes is the TTL, same as today's hand-rolled caches. The probe must
  be strictly cheaper than the load (a sha/hash compare, never a content fetch).
- **Loop-scoped `Map` indexes are not this seam.** The per-call `new Map(...)` indexing in
  services (snapshot compose, `reposByGithubId`, …) stays as-is; this initiative is for
  cross-request caching only.
- **Supply-chain gate**: `layered-loader` is a new dependency; pick the newest version
  older than the `minimumReleaseAge` cutoff; never add a third-party
  `minimumReleaseAgeExclude` entry.
- **HTTP `Cache-Control` stays orthogonal.** The existing header-level caching
  (`/prompt-fragments`, deployment `/models`) is client/edge caching and keeps working;
  don't remove it when the server-side cache lands.
- **Don't confuse with LLM prompt caching.** `agents/src/providers/cache.ts` +
  `kernel/domain/cache-policy.ts` are provider-side prompt-prefix caching: unrelated,
  untouched.
- **Delete the bespoke cache when a slice replaces it** (pre-1.0, no back-compat): the
  5s `LocalSettingsService` cache, `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`, the `tokenCache`
  Map each go away in their slice, not alongside the new path.
- **Changesets every slice**; the pilot's changeset flags the new package + the new
  optional env vars.
- **Slice 2 findings (carry forward):**
  - **The git fragment-source `status()` cache was dropped, not deferred.** `status()` is
    the only caller of the source sha probe, and it is a **cold, user-initiated "check for
    changes" UI action** whose entire job is to answer _live_ whether the repo moved:
    caching it behind a TTL would make the answer stale, a regression. The Markdown bodies
    it would "avoid re-fetching" are already persisted in `prompt_fragments` and served via
    slice 1's catalog cache, so there is no per-run re-fetch to cache. `sync()` stays a live
    write. If a future hot read path over source status appears, revisit, but don't cache a
    must-be-live probe.
  - **A self-verifying cache stays ENABLED on the Worker.** `fragmentDocumentBody` is the
    first cache with real TTLs on the isolate-safe profile: its entries are external page
    content re-validated by the source version probe, so a peer isolate self-heals within
    the refresh window without an invalidation bus (same class as sha-pinned reads). Only
    caches of our own mutable D1 state (`fragmentCatalog`) pass through on the Worker.
  - **The probe needs a real cheap metadata read per provider.** `DocumentContent` gained an
    opaque `version` token and the `DocumentSourceProvider`/`DocumentContentResolver` ports a
    `probeVersion` (Confluence `?expand=version`, Notion `last_edited_time`, GitHub docs
    `latestCommitSha`, Linear `updatedAt`, Figma `?depth=1` version, Zeplin project
    `updated`). A hash-of-body is NOT a valid probe: you had to fetch the body to compute it.
  - **DB body is now the fallback, not the run-time source (behavior change, pre-1.0).** The
    live run-time body flows through `fragmentDocumentBody`; `prompt_fragments.body` is the
    offline fallback + management-view content, refreshed only on an explicit
    `createFromDocument`/`refresh`. This is why the loader load does NOT persist or invalidate
    the catalog (slice 1's churn-on-every-refresh is gone). Body-cache invalidation on writes
    is best-effort: the version probe bounds staleness even if a group can't be resolved.
- **Slice 3 findings (carry forward):**
  - **`linkBlock` is gone: the checklist's original invalidation list was stale.** Block→repo
    linkage no longer lives on `github_repos.block_id`; it flows through the account-owned
    `Service` (`getByFrameBlock` → `repoGithubId`/`directory`). So there is no `linkBlock`
    write to invalidate, and the resolver's linkage read is the (live) ancestry walk.
  - **Cache the projection LIST only, not the whole `resolveRepoTarget` result.** Caching the
    full resolved target (keyed by block) would have to invalidate on installation writes
    (many fan-out sites needing a new `listWorkspacesForInstallation` port consumer), on every
    `Service` repo-link write (~6 sites across board/bootstrap/seed), AND on reparent: a
    sprawling, drift-prone surface for a mostly-bounded read. Instead slice 3 caches ONLY the
    unbounded `repoProjectionRepository.list(workspaceId)` re-list (group=key=`workspaceId`,
    same shape as slice 1). The installation lookup (one cheap read) and the block ancestry
    walk (bounded by tree depth ≤3: task→module→frame) stay live, so **reparent and
    service-link changes need NO cache invalidation**; the entire invalidation surface is the
    projection's own writes, fully enumerable across the GitHub sync/webhook services plus the
    board + bootstrap monorepo/link writes.
  - **Every projection-write site has a `workspaceId` in scope** (a method param, or the
    fan-out loop var in `syncRepo`/the webhook tombstone), so invalidation is always a per-ws
    `invalidateGroup`, no coarse `invalidateAll` needed. The wired sites:
    `GitHubSyncService.{setRepoMonorepo,linkRepo,linkPersonalRepo,setLinkedRepos,syncRepo}`,
    `BoardService.addServiceFromRepo` (the monorepo-flag write on the import-existing-repo
    path; it writes `setMonorepo` directly, NOT via `GitHubSyncService`, so it carries its own
    invalidation), `WebhookService.handleInstallation` (installation_repositories removed), and
    `ContainerRepoBootstrapper.projectBootstrappedRepo`. The push/check_run webhook events
    write OTHER projection tables the resolver never lists, so they do NOT invalidate it.
  - **`syncRepo` invalidates only on a `full` (link-time) pass.** An incremental resync
    (`full` false: queue consumer / periodic reconcile) re-stamps the STORED repo row, so only
    `syncedAt` changes (not a resolver-visible field) and invalidating would just churn the
    per-workspace entry the durable poll ticks reuse. A `full` pass carries freshly-FETCHED
    metadata that a workspace SHARING the repo may hold stale, so it still drops each
    fanned-out workspace's group.
  - **`GitHubSyncService`/`WebhookService` are wired in the SHARED composition root**
    (`orchestration/createGitHubModule`), and `BoardService` gets the same handle from
    `createCore`, so both runtimes get the invalidation uniformly; only the resolver read + the
    bootstrapper are per-facade. On the Worker the cache is pass-through (mutable D1 state,
    isolate-safe), so its resolver reads live and its invalidations are no-ops: correct, not a
    gap (same class as `fragmentCatalog`). **Local mode is pass-through too:** it seeds the
    projection via the out-of-process `link-repo` CLI and runs single-node with no invalidation
    bus, so an in-memory TTL'd entry could serve a pre-link projection: `startLocal` passes a
    `cachesProfile` that disables `repoProjection` (same isolate-safe reasoning as the Worker).
    So the cache is active on the multi-node-capable Node facade only.
  - **Cross-runtime conformance is deferred (documented, like the pilot's real-ioredis test).**
    The conformance harness runs with GitHub OFF (no installation), so `resolveRepoTarget`
    short-circuits to `null` and an HTTP write-then-read coherence test à la slice 1 isn't
    reachable without wiring a full GitHub connection into the harness. The read-through +
    per-site invalidation contract is instead proven by runtime-independent unit tests on the
    SHARED code (`server` resolver read-through/invalidation, `integrations`
    `GitHubSyncService`/`WebhookService` invalidation, the `caching` bag field). Promote to a
    conformance assertion if the harness gains an installation+projection seam.
- **Slice 4 findings (carry forward):**
  - **Cache the `makeResolveRunRepoContext` path ONLY, not every `RepoFiles`.** The hot,
    repeat-read consumer is the engine's pre/post-op hook (`blueprintPostOp`/`specPostOp` byte-compare
    the same branch's files every run/replay). The other `makeRepoFiles` callers are COLD, must-be-live
    reads: the environments module's on-demand repo/config validation (`makeResolveRepoFilesForCoords`,
    an operator "check my config" action, the same must-be-live class as slice 2's dropped fragment
    `status()`) and `GitHubDocQualityProvider`, so they pass no cache and read live. Scoping this way
    also keeps the invalidation surface tiny: only the post-op's own `commitFiles` writes + the push
    webhook, nothing else touches a cached branch.
  - **The staleness probe needs the BRANCH head sha, which the value doesn't carry, so wrap it.**
    Unlike slice 2 (where `DocumentContent.version` self-describes), a `RepoFileContent`'s `sha` is the
    blob sha (changes per file, and re-reading it costs a full contents call, not a cheap probe). The
    cheap branch-wide probe is `branchHeadSha`, so each entry is stored as `CachedRepoRead` carrying the
    branch head it was read at; the probe compares the CURRENT head against it. A cold batch stamps that
    head ONCE (a per-instance memo cleared on `commitFiles`), so caching N files on a branch costs one
    extra head read, not N. The probe itself reads fresh (never the LOAD memo: the point is the current
    head), but a concurrent refresh sweep of one branch's entries still coalesces to ONE head read via a
    separate self-clearing probe memo, so re-validation is +1 head read per sweep, not +N.
  - **`repoFiles` stays ENABLED on the Worker (and local), unlike `repoProjection`.** It is the second
    self-verifying cache (after `fragmentDocumentBody`): the head-sha probe re-validates a branch read
    without a cross-isolate bus, so its staleness is bounded by the probe rather than indefinite. NOTE
    (amended by slice 11): the Worker used to rebuild the whole `AppCaches` bag per invocation, so this
    cache mainly deduped reads WITHIN one wake; the bag is now a module-scope singleton
    (`appCachesHost.ts`), so a warm isolate keeps entries across requests and the refresh-window probe
    fires on the Worker too. Local is
    single-node, so `commitFiles` self-invalidation is already fully coherent AND the probe backstops the
    one out-of-process writer (the agent container's git push), which never touches the `spec/`/`blueprints/`
    paths these post-ops read anyway. So no local `cachesProfile` disable (contrast slice 3's `repoProjection`,
    which has no probe and so must pass through where there's no bus).
  - **Head-read robustness + group casing (review hardening).** The added head read must not make a cached
    read LESS robust than the uncached path: a transient `branchHeadSha` failure degrades to an unstamped
    entry (probe always reloads) instead of failing the content read, and a rejected head promise is evicted
    from the memo (never poisons the rest of the batch). `repoFilesCacheGroup` lower-cases owner/repo (the
    read path derives them from the projected row, the invalidation path from the raw push payload: GitHub
    is case-insensitive, so normalising here stops a casing difference silently no-op'ing the invalidation);
    `ref` stays case-sensitive. `isPinnedSha` is a shape check: a branch literally named as 40 hex chars is
    a bounded, accepted edge (the engine's refs are `cat-factory/<blockId>` or genuine shas).
  - **Group = one branch of one repo (`<inst>:<owner>/<repo>@<branch>`), key = `f:`/`d:` + path.** So
    `commitFiles(branch)` and a push webhook each drop exactly the branch they moved, at path granularity
    within it. The group key is a kernel helper (`repoFilesCacheGroup`) shared by the server wrapper (which
    reads through) and the integrations webhook (which invalidates) so the two can't drift. A `getFile` with
    NO `gitRef` (the repo default branch, whose name the bound `RepoFiles` doesn't know) bypasses the cache;
    the post-ops always pass a concrete branch, so nothing hot is lost. Sha-pinned reads are immutable (probe
    is a constant `true`, no head read).
  - **Push webhook invalidates the branch group (every push, not just the app's own).** An agent
    container's git push or a human PR-branch edit moves the branch outside the app's `commitFiles`
    self-invalidation; the push handler drops that branch's group (one call, workspace-independent, since
    the cache is installation+repo+branch-scoped). Over-invalidation on an unrelated-file push is safe and
    cheap; the head-sha probe is the additional backstop between pushes.
  - **Cross-runtime conformance deferred (same as slice 3).** The conformance harness runs GitHub OFF, so
    `resolveRunRepoContext` resolves to `null` and there's no wired `RepoFiles` to drive a write-then-read
    coherence test through. The read-through + probe + invalidation contract is proven by runtime-independent
    unit tests on the SHARED code (`server` `test/repoFiles.spec.ts`: read-through/head-sha probe/commit
    invalidation/pinned-immutable/default-branch-bypass/probe-coalescing/transient-head-failure; `integrations`
    `WebhookService` push invalidation; the `caching` bag field). Promote if the harness gains a
    GitHub-connected repo seam. (The `server` package's vitest only globs `test/**/*.spec.ts`, so the spec
    lives under `test/`, not as a `src/**/*.test.ts`: the latter would silently never run.)

- **Slice 11 findings (the Worker pull-coherency pilot; carry forward):**
  - **Pull, not push, and a new seam rather than the notification pair.** An isolate holds no
    subscription between requests, so the consumer half of a notification pair structurally
    cannot exist on the Worker. The mechanism is layered-loader 16.1's edge recipe: a
    `CacheGenerationStore` (one MONOTONIC counter per (cache, group); the Worker's is the
    `CacheGenerationDirectory` DO, sharded `idFromName(group)` so ONE read serves every
    coherent cache's view of a group), a per-bag `GroupGenerationTracker` probing it at most
    once per `coherencyWindowMsecs`, and `applyRemoteInvalidationForGroup` (synchronous,
    local, non-publishing, FENCING: an in-flight load cannot resurrect the invalidated
    entry) applied on a moved counter. The pair seam was evaluated and rejected: it is
    per-cache (no batched probe), push-shaped, and its publishes are fire-and-forget where
    the bump's returned generation must flow back for self-echo suppression.
  - **Error posture: reads fail CLOSED, bumps fail OPEN.** A failed probe locally
    invalidates and leaves the window unestablished, so a directory outage degrades to
    pass-through performance, never staleness. A failed bump resolves (the write and local
    drop already happened; peers heal at the TTL) with `cache.coherency_bump_failure` as
    the trace. Four new members joined the closed `OperationalCounter` union + OTel maps.
  - **`invalidateAll` rides a reserved `'*'` epoch group** (its own shard, probed on its own
    timestamp, mapping to a full local clear), so the store interface stays two methods. The
    pilot cache never calls it, deliberately: `workspaceSettings` won over `fragmentCatalog`
    exactly because its ONE invalidation site has no `invalidateAll` in the critical
    surface, and over `repoProjection` because the Worker deliberately does not thread that
    cache into its read path (`container-vcs-identity.ts`).
  - **The module-scope bag is a prerequisite, and background work must be adopted.** The
    Worker bag is now one per isolate (`appCachesHost.ts`; profile picked by the binding, so
    an un-edited wrangler.toml degrades to the old pass-through stance rather than caching
    without coherency). Hoisting makes the refresh-window caches genuinely spawn
    cross-request background reloads, so `scheduleBackgroundWork` (new in 16.1) is threaded
    to every loader and the Worker's adopter reads the CURRENT invocation's
    ExecutionContext off an AsyncLocalStorage (`requestContext.ts`) and hands the promise to
    `ctx.waitUntil`; a `ctx` captured at construction, or a drain-based pending registry,
    both re-introduce the cross-request I/O fault under concurrency. Workflows steps have no
    ExecutionContext: their coherency probes are awaited inline (fine), and detached
    refreshes fall back to `void work` (upstream guarantees the promise settles fulfilled).
  - **Read-your-write held without weakening conformance.** The write path's local drop
    plus the awaited bump means the same isolate reads fresh immediately; the probe window
    only bounds ANOTHER isolate's staleness (5s on the pilot). `defineCacheSuite` runs
    unchanged on the coherent profile.
  - **Watch before flipping fatter caches**: the probe is one awaited DO subrequest per
    group per window per isolate; `cache.coherency_probe` volume and the hit rate say
    whether the next candidate (`fragmentCatalog`, whose account-tier writes will exercise
    the `'*'` path; `repoProjection`, which needs Worker read-path threading) pays.
  - **Upstream notes for layered-loader live in
    `docs/internal/layered-loader-upstream-gaps.md`** (what this slice hand-rolled that
    wants a first-class home upstream).

## Out of scope

- A Redis (or any async) **data** tier; cache warming; cross-request memoization of LLM
  calls.
- A PUSH-shaped Worker invalidation bus (a Durable Object broadcasting to isolates):
  isolates cannot hold subscriptions, so the Worker's mechanism is slice 11's PULL
  (generation-probe) design; further cache flips ride that, one profile row per slice.
- Postgres LISTEN/NOTIFY or NATS as alternative notification transports (the injected
  `notificationPairFactory` seam leaves room; not built now).
- Row 8's candidates until each is evaluated against real read volume: snapshot caching
  in particular is mutation-heavy and may never pay for its invalidation complexity.
