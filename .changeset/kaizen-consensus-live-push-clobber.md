---
'@cat-factory/app': patch
---

fix(stores): guard the kaizen & consensus stores against out-of-order live-push clobber

Two live-backed Pinia stores blind-replaced state that also arrives over the workspace
stream, so a load resolving after a fresher live push (or a newer concurrent load) silently
dropped the fresher data — the out-of-order-overwrite hazard the live-push coherence rules
warn about, the same class the `provisioningLogs` store was hardened against.

- **kaizen**: `loadForExecution` and `loadOverview` now take a monotonic load ticket (only
  the newest-issued load commits) and merge the fetched gradings with the live cache instead
  of replacing it, so a grading pushed via `upsert` while a load was in flight is preserved
  rather than dropped (loaded rows stay authoritative per id, keeping the newer `updatedAt`
  on a shared id). Gradings are append/update-only, so preserving an unmatched live row can't
  resurrect stale state.
- **consensus**: `load` now reconciles through the same newest-wins (`updatedAt`) rule the
  live `upsert` uses instead of blind-replacing, so a stale load can't regress the transcript,
  and a raced "no session" response never clobbers an existing (possibly live-pushed) session.

`docInterview` already routed its `load` through `upsert`'s newest-wins guard; it gains a
regression spec so a future refactor can't reintroduce the clobber. Establishes the
"every store with both a snapshot/load path and a live-upsert path gets an out-of-order
spec" burn-down (system-audit tracker item 15) with these three stores as the first slice.
