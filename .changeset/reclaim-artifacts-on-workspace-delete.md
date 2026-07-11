---
'@cat-factory/kernel': minor
'@cat-factory/workspaces': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Reclaim a deleted board's binary artifacts (screenshots + reference images) — BOTH the
metadata rows AND the heavy blob bytes — so they no longer leak forever.

The artifact retention sweeps only ever iterate LIVE workspaces (`listVisible`), and
`binary_artifacts` is deliberately excluded from the SQL workspace-delete cascade (dropping
the metadata row without the bytes would strand the blob in object storage forever — the row
is the only handle on its key). So before this change, deleting a board orphaned both the
metadata rows and their backing R2 / S3 / filesystem bytes with nothing to reclaim them —
unbounded object-storage cost with no surfacing.

`BinaryArtifactStore` gains `deleteByWorkspace(workspaceId)` (backed by new
`listByWorkspace` / `deleteByWorkspace` metadata-store methods, mirrored D1 ⇄ Drizzle),
reusing the same fail-safe blobs-first-then-rows ordering as `pruneOlderThan`: a blob whose
delete throws keeps its metadata row so a later retry can still reach the bytes rather than
orphaning them. `WorkspaceService.delete` now purges through this port (best-effort — a
storage outage can't wedge the board delete) before the row cascade runs. The cross-runtime
binary-artifact conformance suite asserts the reclaim removes every artifact's rows + bytes,
scoped to the workspace, on both D1 and Postgres. (system-audit-improvements initiative,
item 3.)
