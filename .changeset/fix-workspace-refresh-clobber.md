---
'@cat-factory/app': patch
---

Fix a live-push race where a spawned task/module block (or a bootstrap frame) could intermittently
never appear on the board. A `board`-type stream event triggers a full `workspace.refresh()`, and
`hydrate` REPLACES the block list; two refreshes could be in flight at once (board events >300ms
apart, or the on-connect resync racing a board event), so a slower/staler fetch resolving AFTER a
newer one clobbered it — dropping the just-added block with no further event to restore it.
`refresh()` now stamps each call with a monotonic sequence and commits only the latest-issued
result, so the freshest snapshot always wins regardless of network resolution order. Adds a
store-level regression test pinning the out-of-order case.
