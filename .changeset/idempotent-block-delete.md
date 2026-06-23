---
'@cat-factory/orchestration': patch
---

Deleting a board block (service/module/task) is now idempotent and best-effort: a
block whose row is already gone — e.g. a half-deleted service that left a dangling
mount, repo-link or execution — no longer fails with `404 Block '…' not found`.
`BoardService.removeBlock` tolerates an absent block, falling back to cleaning up
every related entity it can still find (executions, repo links, the account-owned
service + its mounts, surviving descendants) instead of letting "not existing"
block the deletion. A block that exists but is homed in another, un-mounted
workspace still 404s (the visibility boundary is unchanged). The cross-runtime
conformance suite now asserts the idempotent delete against both facades.
