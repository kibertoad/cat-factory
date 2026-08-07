# @cat-factory/caching

The app-level caching seam (see `docs/initiatives/caching-layer.md` in the repo).
`createAppCaches(options)` builds the named, typed read-through caches the services
consume through the kernel `AppCaches` port, implemented on
[`layered-loader`](https://github.com/kibertoad/layered-loader).

## Design rules

- **In-memory only.** Each cache is a per-replica LRU (`layered-loader` `GroupLoader`
  over its in-memory tier). A replica always repopulates from its own data source on a
  miss. There is deliberately **no Redis (or any async) data tier**.
- **Redis is an invalidation bus, never a data tier.** In a multi-node Node deployment
  the facade injects a `notificationPairFactory` (built from layered-loader's
  `createGroupNotificationPair` over dedicated ioredis clients, gated on `REDIS_URL`);
  a write on one node then broadcasts the invalidated key/group so every peer drops its
  in-memory entry. Only keys/groups travel on the wire, never values. Absent the
  factory (single replica, local mode, tests) the loaders are bare in-memory with zero
  extra dependency.
- **Invalidate after commit, at every write site.** The consuming service calls
  `invalidate`/`invalidateGroup` (or the coarse `invalidateAll` for rare wide-blast
  writes) after the DB write commits; layered-loader publishes to peers automatically.
- **Staleness probes for git-backed caches.** A profile with `ttlLeftBeforeRefreshInMsecs`
  turns on preemptive in-memory refresh (layered-loader ≥ 14.5.3): an entry hit inside the
  window runs the caller's per-read `isStillCurrent` probe (a sha/hash compare, strictly
  cheaper than the load) in the background: TTL bump when the source hasn't moved, full
  background reload otherwise. DB-backed invalidation-driven caches leave the window unset:
  a DB read as a probe saves nothing over the DB read as the load.
- **Deep imports keep ioredis out of every runtime but Node.** layered-loader's root
  index eagerly loads its Redis modules (and `ioredis`), so this package deep-imports
  only the in-memory machinery. The Redis notification classes are loaded dynamically
  by the Node facade alone, behind `REDIS_URL`.

## The Cloudflare Worker profiles

A Worker isolate has no cross-isolate invalidation bus and no Redis, so a bare TTL'd
in-isolate cache over **mutable cross-instance state** would serve stale data after a
write processed by another isolate: a correctness bug, not an optimization. Push is
structurally unavailable there (an isolate holds no subscription between requests), so
the Worker has two stances, selected by whether its `CACHE_GENERATIONS` Durable Object
binding exists:

- **`ISOLATE_SAFE_APP_CACHES_PROFILE`** (the fallback, and prior behaviour): caches of
  mutable state are **pass-through** (`enabled: false`; every read runs its load), and
  only caches of immutable or self-verifying entries (sha-pinned repo reads, external
  documents re-validated by a version probe) get real TTLs.
- **`ISOLATE_COHERENT_APP_CACHES_PROFILE`**: the isolate-safe profile plus
  **pull-coherent** caches. A coherent cache keeps a real TTL, and its profile entry
  carries a `coherencyWindowMsecs`: a read whose group snapshot is older than the
  window re-reads the injected `CacheGenerationStore` (one monotonic counter per
  (cache, group), one round trip per group serving every coherent cache) and, on a
  moved counter, applies layered-loader 16.1's local, fencing, non-publishing
  `applyRemoteInvalidation*` primitives before serving. Every invalidation site bumps
  the directory right after its local invalidation, awaited by the write path.
  Cross-isolate staleness is bounded by the window (5s on the pilot), instead of
  indefinite (a bare TTL) or zero-at-the-cost-of-every-read (pass-through).

Error posture, deliberately asymmetric: a probe failure fails CLOSED (the read
invalidates locally and loads fresh, so a directory outage degrades to pass-through
performance, never staleness); a bump failure fails OPEN (the write and its local
invalidation already happened; peers heal at the TTL, and
`cache.coherency_bump_failure` is the visible trace). `createAppCaches` refuses a
profile that sets a window on an enabled cache with no `generationStore` wired.

On isolate runtimes the loaders' detached background work (preemptive refreshes,
probes) must be adopted by the current request: pass `scheduleBackgroundWork` and hand
the promise to `ctx.waitUntil` (the Worker reads the ambient ExecutionContext off an
AsyncLocalStorage; see `runtimes/cloudflare/src/infrastructure/appCachesHost.ts`).

`fragmentDocumentBody` is the first self-verifying cache that stays **enabled** on the
Worker even without the directory: its entries are external Confluence/Notion/GitHub/…
page content re-validated by the source's cheap version probe
(`ttlLeftBeforeRefreshInMsecs` + `isStillCurrent`), so a peer isolate's cached body
self-heals within the refresh window without an invalidation bus.
`workspaceSettings` is the pull-coherency pilot (one invalidation site, no
`invalidateAll`, hot on the Worker); further flips are one profile row each, in their
own slice.

## Named caches

| Cache                  | Value                                           | Group / key                                          | Profile                                       |
| ---------------------- | ----------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| `fragmentCatalog`      | merged per-workspace catalog                    | `workspaceId` / `workspaceId`                        | TTL + invalidation; pass-through on Worker    |
| `fragmentDocumentBody` | a document-backed fragment's live external body | `viaWorkspaceId` / `<source>:<externalId>`           | TTL + version probe; enabled on both facades  |
| `repoProjection`       | a workspace's whole GitHub repo projection      | `workspaceId` / `workspaceId`                        | TTL + invalidation; pass-through on Worker    |
| `repoFiles`            | checkout-free `RepoFiles` reads on a branch     | `<inst>:<owner>/<repo>@<branch>` / `f:`\|`d:` + path | TTL + head-sha probe; enabled on both facades |

## Usage

```ts
import { createAppCaches } from '@cat-factory/caching'

// Node facade (multi-node): inject the Redis-backed notification pair factory.
const caches = createAppCaches({ notificationPairFactory, logger })

// Cloudflare Worker: the module-scope host picks the coherent profile when the
// CACHE_GENERATIONS Durable Object is bound, else the isolate-safe fallback
// (runtimes/cloudflare/src/infrastructure/appCachesHost.ts).
const caches = createAppCaches({
  profile: ISOLATE_COHERENT_APP_CACHES_PROFILE,
  generationStore, // DO-backed on the Worker; any CacheGenerationStore elsewhere
  scheduleBackgroundWork, // adopt detached refreshes onto ctx.waitUntil
})

// A consuming service reads through its named handle…
const catalog = await caches.fragmentCatalog.get(key, workspaceId, () => loadCatalog())
// …and every write path invalidates after commit.
await caches.fragmentCatalog.invalidateGroup(workspaceId)
```
