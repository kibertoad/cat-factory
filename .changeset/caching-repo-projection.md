---
'@cat-factory/caching': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': patch
'@cat-factory/node-server': patch
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
exact-set write + tombstone / the per-sync re-stamp, fanned out per workspace),
`WebhookService` (the `installation_repositories` removed tombstone), and
`ContainerRepoBootstrapper` (projecting a freshly bootstrapped repo). The
installation lookup and the tree-depth-bounded block ancestry walk stay live, so
a block reparent or a service repo-link change needs no cache invalidation.

The cache is pass-through on the Cloudflare Worker's isolate-safe profile (our own
mutable D1 state, no cross-isolate invalidation bus), so it caches only on the
Node/local facades; the Worker reads the projection live. Absent a cache
(tests / harnesses) every resolve lists live, unchanged.
