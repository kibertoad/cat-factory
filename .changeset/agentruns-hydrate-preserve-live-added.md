---
'@cat-factory/app': patch
---

fix(board): don't drop a live-added bootstrap run when a stale snapshot resync races it

`agentRuns.hydrate` reconciled a workspace snapshot by mapping over the incoming jobs only, so
a bootstrap run that a live `bootstrap` event had just ADDED — but which a stale, in-flight
snapshot (the stream's on-connect resync, fetched before the run started) never observed — was
silently dropped. A terminal bootstrap emits nothing further, so the service frame was stranded
on a stale "bootstrapping…" badge (or lost its failure banner) with no event to correct it.

`hydrate` now preserves cached runs the snapshot hasn't observed yet, scoped to the workspace
(bootstrap runs carry `workspaceId`), so a board switch still discards the previous board's runs.
This also fixes the intermittent `bootstrap-live` e2e failure (the live failure banner never
arriving within the timeout under shard load, only to pass on a page-reload retry).
