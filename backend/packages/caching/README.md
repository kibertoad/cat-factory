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
  in-memory entry. Only keys/groups travel on the wire — never values. Absent the
  factory (single replica, local mode, tests) the loaders are bare in-memory with zero
  extra dependency.
- **Invalidate after commit, at every write site.** The consuming service calls
  `invalidate`/`invalidateGroup` (or the coarse `invalidateAll` for rare wide-blast
  writes) after the DB write commits; layered-loader publishes to peers automatically.
- **Staleness probes for git-backed caches.** A profile with `ttlLeftBeforeRefreshInMsecs`
  turns on preemptive in-memory refresh (layered-loader ≥ 14.5.3): an entry hit inside the
  window runs the caller's per-read `isStillCurrent` probe (a sha/hash compare, strictly
  cheaper than the load) in the background — TTL bump when the source hasn't moved, full
  background reload otherwise. DB-backed invalidation-driven caches leave the window unset:
  a DB read as a probe saves nothing over the DB read as the load.
- **Deep imports keep ioredis out of every runtime but Node.** layered-loader's root
  index eagerly loads its Redis modules (and `ioredis`), so this package deep-imports
  only the in-memory machinery. The Redis notification classes are loaded dynamically
  by the Node facade alone, behind `REDIS_URL`.

## The Cloudflare Worker profile (`ISOLATE_SAFE_APP_CACHES_PROFILE`)

A Worker isolate has no cross-isolate invalidation bus and no Redis, so a TTL'd
in-isolate cache over **mutable cross-instance state** would serve stale data after a
write processed by another isolate — a correctness bug, not an optimization. The
Worker therefore wires the isolate-safe profile: caches of mutable state are
configured **pass-through** (`enabled: false` — every read runs its load), and only
caches of immutable or self-verifying entries (sha-pinned repo reads, static
catalogs) get real TTLs. Distributed invalidation is a
genuine Node-only concern, not a facade-parity gap: the Worker's cross-instance state
already lives in globally-addressed Durable Objects / D1. Revisit only if a
per-isolate staleness bug actually surfaces.

`fragmentDocumentBody` is the first self-verifying cache that stays **enabled** on the
Worker: its entries are external Confluence/Notion/GitHub/… page content re-validated
by the source's cheap version probe (`ttlLeftBeforeRefreshInMsecs` + `isStillCurrent`),
so a peer isolate's cached body self-heals within the refresh window without an
invalidation bus — its staleness is bounded by the probe, exactly like a sha-pinned
read. Only `fragmentCatalog`, which mirrors our own mutable D1 rows, passes through.

## Named caches

| Cache                  | Value                                           | Group / key                                | Profile                                      |
| ---------------------- | ----------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| `fragmentCatalog`      | merged per-workspace catalog                    | `workspaceId` / `workspaceId`              | TTL + invalidation; pass-through on Worker   |
| `fragmentDocumentBody` | a document-backed fragment's live external body | `viaWorkspaceId` / `<source>:<externalId>` | TTL + version probe; enabled on both facades |

## Usage

```ts
import { createAppCaches } from '@cat-factory/caching'

// Node facade (multi-node): inject the Redis-backed notification pair factory.
const caches = createAppCaches({ notificationPairFactory, logger })

// Cloudflare Worker: the isolate-safe profile.
const caches = createAppCaches({ profile: ISOLATE_SAFE_APP_CACHES_PROFILE })

// A consuming service reads through its named handle…
const catalog = await caches.fragmentCatalog.get(key, workspaceId, () => loadCatalog())
// …and every write path invalidates after commit.
await caches.fragmentCatalog.invalidateGroup(workspaceId)
```
