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
catalogs) get real TTLs as later slices add them. Distributed invalidation is a
genuine Node-only concern, not a facade-parity gap: the Worker's cross-instance state
already lives in globally-addressed Durable Objects / D1. Revisit only if a
per-isolate staleness bug actually surfaces.

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
