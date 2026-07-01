---
'@cat-factory/app': patch
---

fix(board): announce the workspace stream as connected only after its on-connect resync settles

The real-time stream flipped `connected` the moment the socket opened, then fired the
reconcile `workspace.refresh()` in the background. Under load that snapshot — fetched at
connect time — could resolve AFTER a fresh live event and clobber it: `board.hydrate`
replaces the block list wholesale, so it dropped a just-created provisional bootstrap frame
the stale snapshot never saw, and its live "bootstrapping…" badge flickered out with no
further board event to restore it.

`connected` (and its `data-connected` attribute) now means "connected AND reconciled" — it is
set only after the on-connect refresh settles (still on failure, so a transient refresh error
can't wedge the indicator). Anything acting on a connected board — a user, or an e2e spec that
gates on `data-connected` — now does so after the reconcile, so a lagging resync can't drop the
state that action produces. Deflakes the `bootstrap-live` "provisional frame + live progress
badge" e2e spec.
