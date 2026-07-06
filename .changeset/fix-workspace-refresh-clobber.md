---
'@cat-factory/app': patch
---

Harden `workspace.refresh()` against an out-of-order full-refresh clobber. A `board`-type stream
event triggers a full snapshot refresh and `hydrate` REPLACES the block list; two refreshes can be
in flight at once (board events >300ms apart, or the on-connect resync racing a board event), so a
slower/staler fetch resolving AFTER a newer one would overwrite it and drop live-added state.
`refresh()` now stamps each call with a monotonic sequence (and re-checks the active board) and
commits only the latest-issued result, so the freshest snapshot always wins regardless of network
resolution order. Adds a store-level regression test. This closes a real latent race in the
live-push layer — defensive hardening, not tied to a specific reported symptom.
