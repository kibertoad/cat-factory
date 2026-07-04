---
'@cat-factory/caching': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/worker': patch
---

Cache the workspace GitHub repo projection through the app caching seam
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
