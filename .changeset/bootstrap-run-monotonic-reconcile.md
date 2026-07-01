---
'@cat-factory/app': patch
---

Fix a live-vs-snapshot race that could leave a failed repo-bootstrap frame stuck on the
"bootstrapping…" badge. A `board` event triggers a debounced `workspace.refresh()`, and that
snapshot read can resolve AFTER a newer `bootstrap` event has already landed — a blind
re-hydrate then regressed a terminal run (e.g. a `failed` bootstrap reverting to `running`,
with no further event to correct it). `agentRuns` now reconciles bootstrap runs monotonically
by `updatedAt`, so a lagging refresh (or out-of-order event) can't clobber a live transition.
