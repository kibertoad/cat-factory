# Initiative: caching layer (layered-loader, in-memory + Redis-notified invalidation)

**Status:** in progress — pilot (row 0) + slices 1–3 landed · **Owner:** core ·
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
  `listDirectory` calls against the same branch for idempotency byte-compares — live GitHub
  contents-API round-trips every run.
- **Per request**: the per-workspace `GET /models` + `resolveWorkspaceCapabilities`
  recompute provider/key/subscription capability sets on every call.

Where caching does exist it is hand-rolled and instance-local: `GitHubAppAuth`'s module
`tokenCache` Map, `LocalSettingsService`'s 5s TTL cache, the fragment library's bespoke
5-minute doc-fragment TTL (`DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`). None of these invalidate
across replicas, so a horizontally-scaled Node deployment serves stale data for the TTL
window after any write — the same class of gap the realtime `WebSocketPropagator` work
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

- **layered-loader's root index eagerly loads its Redis modules, and `ioredis` is a HARD
  dependency of layered-loader 14.x.** So "ioredis stays out" is enforced at the _module
  graph_, not the install: `@cat-factory/caching` deep-imports ONLY the in-memory modules
  (`layered-loader/dist/lib/GroupLoader.js` etc. — safe in workerd, proven by the Worker
  conformance run), and only the Node facade's `REDIS_URL`-gated dynamic import
  (`cacheNotifications.ts`) ever touches `createGroupNotificationPair`/ioredis.
- **The consumer-facing interfaces live in kernel** (`ports/caching.ts`: `AppCaches`,
  `GroupCacheHandle`), per the repo's ports-in-kernel rule — so services (agents) depend
  on no caching machinery; `@cat-factory/caching` is the implementation the composition
  roots build. `ResolvedCatalogEntry` moved to kernel so the port can name it. The handle's
  `get(key, group, load)` carries the load closure per call (the owning service keeps its
  load logic; the loader keeps in-flight dedup) — no late-bound data-source binding.
- **Slice 1 keys by `workspaceId` alone (not `(accountId, workspaceId)`)** — the account is
  resolved inside the load, so a cache hit costs ZERO reads (an accountId-bearing key would
  re-read `accountOf` on every hit); a workspace never changes accounts. Account-tier
  writes invalidate via the coarse `invalidateAll()` (rare management actions; enumerating
  the account's workspaces would need a new `WorkspaceRepository` port method whose only
  consumer is invalidation — over-invalidation is safe and cheaper).
- **The in-memory staleness probe is fully supported since layered-loader `14.5.3`**
  (upstreamed per `docs/proposals/layered-loader-in-memory-staleness-probe.md`; earlier
  14.5.x hard-gated `isEntryStillCurrentFn` on an async cache tier). The seam exposes it
  ready for slices 2/4: a cache profile sets `ttlLeftBeforeRefreshInMsecs`, and the OWNING
  service passes its cheap probe per read — `handle.get(key, group, load, isStillCurrent)`
  — mirroring how the load closure rides the read. An entry hit inside the window probes in
  the background: TTL bump on `true` (no refetch), full background reload on `false`/throw,
  and a read that passes no probe (or a profile with no window) degrades to the blind
  background reload. Covered by the caching package's probe tests. Note `layered-loader` is
  listed (unversioned) in `minimumReleaseAgeExclude` — it is maintainer-owned, same trust
  class as `@cat-factory/*`, so releases like 14.5.3 install without waiting out the
  supply-chain age gate.
- **CI has no Redis service**, so the notification path is covered by fake-bus tests: the
  caching package's two-`AppCaches` test (fake publisher/consumer pair) and
  `runtimes/node/test/cacheNotifications.spec.ts`, which drives the REAL layered-loader
  Redis notification classes (envelope, echo suppression, per-cache channels) over
  injected fake ioredis clients — the `propagator.spec.ts` pattern. The tracker's
  real-ioredis integration test stays open until CI gains a Redis service.

## Target pattern (to be proven by the pilot)

The realtime propagator (`backend/runtimes/node/src/propagator.ts` +
`redisPropagator.ts`, initiative `redis-websocket-propagation`) is the wiring blueprint;
the registry-DI initiative supplies the ownership rule (composition root owns the
instances, no module globals).

1. **New published package `backend/packages/caching` (`@cat-factory/caching`)** wrapping
   `layered-loader` (regular dependency; `ioredis` stays out — see below):
   - **`AppCaches`** — the app-owned bag of _named, typed_ `Loader`/`GroupLoader`/`ManualCache`
     instances (one per checklist row below), created by **`createAppCaches(options)`**.
     Workspace-scoped caches are `GroupLoader`s grouped by `workspaceId` so a
     workspace-wide event (e.g. a GitHub sync) is one `invalidateCacheForGroup` call.
   - **Per-cache config profile**: `cacheType: 'lru-object'`, explicit `ttlInMsecs` +
     `maxItems` per cache, `ttlLeftBeforeRefreshInMsecs` + `isEntryStillCurrentFn` only on
     the git-backed caches. A facade passes a profile so TTLs can differ per runtime.
   - `options.notificationPairFactory?` — an injected factory returning
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
3. **Injection through the existing seams**: `createAppCaches` is called once per process —
   Node `start()` (next to `buildRealtimePropagator`) threading the result through a new
   optional `caches?: AppCaches` field on `NodeContainerOptions` → `CoreDependencies`;
   consuming services take their loader off the single `dependencies` object. Absent ⇒
   the container builds bare in-memory defaults, so tests/harnesses don't change.
   `buildLocalContainer` inherits automatically (and never wires notifications — local is
   single-node by construction).
4. **Cloudflare Worker**: wires `createAppCaches` with the **isolate-safe profile only** —
   caches whose entries are immutable or self-verifying (sha-pinned `RepoFiles` reads,
   static catalogs) get real TTLs; caches of mutable cross-instance state are configured
   `ttlInMsecs: 0` (pass-through), because a Worker isolate has no cross-isolate
   invalidation bus and no Redis. Like the propagator, distributed invalidation is a
   **genuine Node-only concern, not a facade-parity gap** — the Worker's cross-instance
   state already lives in globally-addressed Durable Objects / D1. Document this in the
   package README; revisit only if a per-isolate staleness bug actually surfaces.
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
   a new published package") — `prepublishOnly`, `files: ["dist"]`, registration in
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
slice-2 findings below, and the GitHub-docs case IS the doc-backed row above — GitHub docs
are one of the `DocumentSourceProvider`s, probed via `latestCommitSha`.)

Sha-**pinned** reads (`getFile(path, <sha>)`) are immutable — long TTL, no checker needed.
DB-backed caches (fragment catalog, repo projection, presets, capabilities) do **not** use
the checker: they are invalidation-driven (a DB read as a probe saves nothing over the DB
read as the load).

## Per-cache checklist

Phase 0 is the pilot and lands the machinery; every later row is "adopt the seam for one
target + wire ALL its invalidation sites + tests" and should be a small PR.

| #   | Slice                                                                                                                                                                                                                                                                                                       | Key files today                                                                                                                                                                                   | Cache key / group                                             | Invalidated by                                                                                                                                    | Staleness checker                                                      | Status                          | PR                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| 0   | **Pilot: `@cat-factory/caching` + notification wiring + seams + conformance suite** (target pattern §1–§7, with slice 1 as the proving consumer; real-ioredis CI test still open — no Redis service in CI)                                                                                                  | new package; `runtimes/node/src/server.ts`, `container.ts`, `cacheNotifications.ts`; `runtimes/cloudflare/.../container.ts`; `internal/conformance/src/cache-suite.ts`; kernel `ports/caching.ts` | —                                                             | —                                                                                                                                                 | —                                                                      | ✅ done                         | [#767](https://github.com/kibertoad/cat-factory/pull/767) |
| 1   | **Fragment catalog** — `FragmentLibraryService.resolveCatalog` (per-dispatch tenant merge)                                                                                                                                                                                                                  | `agents/src/fragmentLibrary/FragmentLibraryService.ts`                                                                                                                                            | group `workspaceId`, key `workspaceId` (see pilot deviations) | fragment `create`/`update`/`remove`/`createFromDocument`/`refresh` + the run-time document-body re-resolve; `FragmentSourceService.sync`/`unlink` | no                                                                     | ✅ done                         | [#767](https://github.com/kibertoad/cat-factory/pull/767) |
| 2   | **Doc-backed fragment bodies** — replace `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS` with the `fragmentDocumentBody` loader + version probe. (The git fragment-source `status()` half was evaluated and **dropped** — see the conventions note; it's a cold, must-be-live UI action with no hot read path to cache.) | `agents/src/fragmentLibrary/FragmentLibraryService.ts`; `kernel/ports/{document-source,caching}.ts`; `caching/src/appCaches.ts`; `integrations/.../documents/*Provider.ts`                        | group `viaWorkspaceId`, key `<source>:<externalId>`           | fragment `create`/`refresh`/`update`/`remove` (best-effort; the version probe bounds staleness regardless)                                        | **yes** (provider `version` token vs cached `DocumentContent.version`) | ✅ done                         | [#782](https://github.com/kibertoad/cat-factory/pull/782) |
| 3   | **Repo projection** — `repoProjectionRepository.list` (per dispatch, per poll tick). Caches the whole-projection re-list only; the installation lookup + tree-depth-bounded ancestry walk stay live (so reparent/service-link need no invalidation). See the slice-3 findings.                              | `server/src/agents/resolveRepoTarget.ts`, `ContainerRepoBootstrapper.ts`; `integrations/.../github/{GitHubSyncService,WebhookService}.ts`; `orchestration/src/container.ts`                       | group `workspaceId`, key `workspaceId`                        | `GitHubSyncService` link/monorepo/setLinkedRepos/syncRepo + `WebhookService` installation-removed tombstone + `ContainerRepoBootstrapper` project | no                                                                     | ✅ done                         | _this PR_                                                 |
| 4   | **`RepoFiles.getFile`/`listDirectory`** — repo-op idempotency re-reads (`blueprintPostOp`, `specPostOp`, spec excerpts)                                                                                                                                                                                     | `server/src/agents/repoFiles.ts`; `agents/src/repo-ops/builtin.ts`                                                                                                                                | `(installationId, owner, repo, ref, path)`                    | own `commitFiles` (self-invalidate the branch group); push webhook where ingested                                                                 | **yes** for branch refs (`headSha`); pinned shas immutable             | ⬜ todo                         |                                                           |
| 5   | **Workspace capabilities + per-workspace `GET /models`**                                                                                                                                                                                                                                                    | `server/src/agents/providerCapabilities.ts`; `ModelController.ts`                                                                                                                                 | `(workspaceId, userId)`                                       | API-key / subscription / local-endpoint / OpenRouter-catalog writes                                                                               | no                                                                     | ⬜ todo                         |                                                           |
| 6   | **`LocalSettingsService`** — migrate the bespoke 5s cache (multi-replica correctness win: today a peer serves stale settings for the TTL)                                                                                                                                                                   | `integrations/src/modules/localSettings/LocalSettingsService.ts`                                                                                                                                  | singleton key                                                 | `write()`                                                                                                                                         | no                                                                     | ⬜ todo                         |                                                           |
| 7   | **`GitHubAppAuth` token cache** — migrate the module `tokenCache` Map to a `ManualCache` (hygiene: TTL from `expiresAt`; NO notifications — tokens are per-process, never broadcast, and notifications carry keys only anyway)                                                                              | `server/src/github/GitHubAppAuth.ts`                                                                                                                                                              | `installationId`                                              | expiry only                                                                                                                                       | no                                                                     | ⬜ todo                         |                                                           |
| 8   | **Evaluate, don't assume**: workspace snapshot sub-reads, `requirementReviews.getByBlock` / linked docs in `buildAgentContext`, merge presets, OpenRouter catalog                                                                                                                                           | `WorkspaceService.snapshot`; `AgentContextBuilder.ts`; `MergePresetService.ts`                                                                                                                    | —                                                             | —                                                                                                                                                 | —                                                                      | ⬜ decide per-item when reached |                                                           |

## Conventions & gotchas (carry between iterations)

- **Redis is an invalidation bus, never a data tier.** No `RedisCache` async layer, no
  values on the wire — only keys/groups. A replica always repopulates from its own data
  source. If someone proposes adding the async tier, that's a new initiative.
- **Gate on `REDIS_URL`, mirror the propagator, keep `ioredis` optional.** Dynamic
  `import('ioredis' as string)`, `optionalDependencies` in the Node facade only, dedicated
  publisher + subscriber clients (a subscribed connection can't issue commands), error
  handlers attached synchronously, don't await `subscribe` at boot, graceful `quit()` with
  `disconnect()` fallback. Do NOT share the realtime propagator's clients — separate
  concern, separate channel; consolidating a shared Redis connection factory is allowed
  later but is not this initiative's job.
- **Local mode never wires notifications.** It's single-node by construction
  (`runtimes/local/src/server.ts` passes the bare hub for realtime; caches follow the same
  rule). Bare in-memory loaders are the correct local configuration, not a degraded one.
- **Worker = isolate-safe profile only** (immutable/sha-pinned + static entries; mutable
  cross-instance caches pass through). Never wire a TTL'd in-isolate cache over mutable
  shared state on the Worker — with no invalidation bus that's a correctness bug, not an
  optimization.
- **Invalidate after commit, at every write site.** Enumerate the write paths per slice
  (the checklist's "invalidated by" column) before coding; a missed site is a stale-read
  bug that only shows up multi-replica. Webhook-driven sources must invalidate from the
  webhook ingest path too.
- **`isEntryStillCurrentFn` runs only in the refresh window** (`ttlLeftBeforeRefreshInMsecs`)
  — it does not guard normal cache hits. Size TTL vs window accordingly: the freshness
  guarantee between probes is the TTL, same as today's hand-rolled caches. The probe must
  be strictly cheaper than the load (a sha/hash compare, never a content fetch).
- **Loop-scoped `Map` indexes are not this seam.** The per-call `new Map(...)` indexing in
  services (snapshot compose, `reposByGithubId`, …) stays as-is; this initiative is for
  cross-request caching only.
- **Supply-chain gate**: `layered-loader` is a new dependency — pick the newest version
  older than the `minimumReleaseAge` cutoff; never add a third-party
  `minimumReleaseAgeExclude` entry.
- **HTTP `Cache-Control` stays orthogonal.** The existing header-level caching
  (`/prompt-fragments`, deployment `/models`) is client/edge caching and keeps working;
  don't remove it when the server-side cache lands.
- **Don't confuse with LLM prompt caching.** `agents/src/providers/cache.ts` +
  `kernel/domain/cache-policy.ts` are provider-side prompt-prefix caching — unrelated,
  untouched.
- **Delete the bespoke cache when a slice replaces it** (pre-1.0, no back-compat): the
  5s `LocalSettingsService` cache, `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`, the `tokenCache`
  Map each go away in their slice, not alongside the new path.
- **Changesets every slice**; the pilot's changeset flags the new package + the new
  optional env vars.
- **Slice 2 findings (carry forward):**
  - **The git fragment-source `status()` cache was dropped, not deferred.** `status()` is
    the only caller of the source sha probe, and it is a **cold, user-initiated "check for
    changes" UI action** whose entire job is to answer _live_ whether the repo moved —
    caching it behind a TTL would make the answer stale, a regression. The Markdown bodies
    it would "avoid re-fetching" are already persisted in `prompt_fragments` and served via
    slice 1's catalog cache, so there is no per-run re-fetch to cache. `sync()` stays a live
    write. If a future hot read path over source status appears, revisit — but don't cache a
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
    `updated`). A hash-of-body is NOT a valid probe — you had to fetch the body to compute it.
  - **DB body is now the fallback, not the run-time source (behavior change, pre-1.0).** The
    live run-time body flows through `fragmentDocumentBody`; `prompt_fragments.body` is the
    offline fallback + management-view content, refreshed only on an explicit
    `createFromDocument`/`refresh`. This is why the loader load does NOT persist or invalidate
    the catalog (slice 1's churn-on-every-refresh is gone). Body-cache invalidation on writes
    is best-effort — the version probe bounds staleness even if a group can't be resolved.
- **Slice 3 findings (carry forward):**
  - **`linkBlock` is gone — the checklist's original invalidation list was stale.** Block→repo
    linkage no longer lives on `github_repos.block_id`; it flows through the account-owned
    `Service` (`getByFrameBlock` → `repoGithubId`/`directory`). So there is no `linkBlock`
    write to invalidate, and the resolver's linkage read is the (live) ancestry walk.
  - **Cache the projection LIST only, not the whole `resolveRepoTarget` result.** Caching the
    full resolved target (keyed by block) would have to invalidate on installation writes
    (many fan-out sites needing a new `listWorkspacesForInstallation` port consumer), on every
    `Service` repo-link write (~6 sites across board/bootstrap/seed), AND on reparent — a
    sprawling, drift-prone surface for a mostly-bounded read. Instead slice 3 caches ONLY the
    unbounded `repoProjectionRepository.list(workspaceId)` re-list (group=key=`workspaceId`,
    same shape as slice 1). The installation lookup (one cheap read) and the block ancestry
    walk (bounded by tree depth ≤3: task→module→frame) stay live, so **reparent and
    service-link changes need NO cache invalidation** — the entire invalidation surface is the
    projection's own writes, fully enumerable in three shared services.
  - **Every projection-write site has a `workspaceId` in scope** (a method param, or the
    fan-out loop var in `syncRepo`/the webhook tombstone), so invalidation is always a per-ws
    `invalidateGroup` — no coarse `invalidateAll` needed. The wired sites:
    `GitHubSyncService.{setRepoMonorepo,linkRepo,linkPersonalRepo,setLinkedRepos,syncRepo}`,
    `WebhookService.handleInstallation` (installation_repositories removed), and
    `ContainerRepoBootstrapper.projectBootstrappedRepo`. The push/check_run webhook events
    write OTHER projection tables the resolver never lists, so they do NOT invalidate it.
  - **`GitHubSyncService`/`WebhookService` are wired in the SHARED composition root**
    (`orchestration/createGitHubModule`), so both runtimes get the invalidation uniformly;
    only the resolver read + the bootstrapper are per-facade. On the Worker the cache is
    pass-through (mutable D1 state, isolate-safe), so its resolver reads live and its
    invalidations are no-ops — correct, not a gap (same class as `fragmentCatalog`).
  - **Cross-runtime conformance is deferred (documented, like the pilot's real-ioredis test).**
    The conformance harness runs with GitHub OFF (no installation), so `resolveRepoTarget`
    short-circuits to `null` and an HTTP write-then-read coherence test à la slice 1 isn't
    reachable without wiring a full GitHub connection into the harness. The read-through +
    per-site invalidation contract is instead proven by runtime-independent unit tests on the
    SHARED code (`server` resolver read-through/invalidation, `integrations`
    `GitHubSyncService`/`WebhookService` invalidation, the `caching` bag field). Promote to a
    conformance assertion if the harness gains an installation+projection seam.

## Out of scope

- A Redis (or any async) **data** tier; cache warming; cross-request memoization of LLM
  calls.
- The Worker gaining a cross-isolate invalidation bus (Durable-Object-brokered or
  otherwise) — revisit only with evidence of a real staleness problem.
- Postgres LISTEN/NOTIFY or NATS as alternative notification transports (the injected
  `notificationPairFactory` seam leaves room; not built now).
- Row 8's candidates until each is evaluated against real read volume — snapshot caching
  in particular is mutation-heavy and may never pay for its invalidation complexity.
