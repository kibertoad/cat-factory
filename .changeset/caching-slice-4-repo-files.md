---
'@cat-factory/kernel': minor
'@cat-factory/caching': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Cache the checkout-free `RepoFiles` reads an agent's pre/post-ops run against a run's
branch (caching-layer initiative, slice 4). A new `AppCaches.repoFiles` group cache serves
the `getFile`/`listDirectory` idempotency byte-compares the `blueprints`/`spec-writer`
post-ops issue every run and durable-driver replay, replacing a live GitHub contents-API
round-trip per file. It is wired only on the `makeResolveRunRepoContext` (pre/post-op) path;
the environments repo-validation and doc-quality reads stay live.

- Grouped per `(installation, owner, repo, branch)` via the new kernel `repoFilesCacheGroup`
  helper and keyed per path (`f:`/`d:` prefixes), so one branch's reads drop together.
- Self-verifying: each entry remembers the branch head sha it reflects, so an entry entering
  its refresh window re-validates with a single cheap `branchHeadSha` compare (bump on an
  unmoved branch, background reload otherwise) instead of re-fetching every file. A sha-pinned
  read is immutable (no probe). The head sha a cold batch stamps is read once per branch
  (memoised), so caching N files costs one extra head read, not N.
- Coherence: the owning `commitFiles` self-invalidates the branch group after it commits, and
  the `push` webhook drops a branch it saw move out-of-band (an agent container's git push or a
  human PR-branch edit). Stays enabled on the Worker's isolate-safe profile (like the
  document-body cache, the head-sha probe re-validates without a cross-isolate bus) and in local
  mode (single-node, so `commitFiles` self-invalidation is already fully coherent).
