---
---

Docs: add the `docs/initiatives/caching-layer.md` tracker — the plan for introducing a
caching layer on `layered-loader` (in-memory only, distributed invalidation via a Redis
notification pair in non-local mode, `isEntryStillCurrentFn` staleness probes for the
git-backed sources). No code changes.
