---
'@cat-factory/app': patch
---

Fix a board-UI race where a lagging workspace refresh clobbered a newer live `execution`
event: the execution store's `hydrate`/`upsert` now reconcile by the run's monotonic
`rev` (keep the newer version; preserve a live-added run the stale snapshot never saw,
scoped to the hydrated board's blocks) instead of blindly replacing — the same guard the
agentRuns store already applies. Previously a run that failed or finished while a
snapshot fetch was in flight could be reverted to "running" and stick there, since a
terminal run emits no further events.
