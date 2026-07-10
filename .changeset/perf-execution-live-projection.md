---
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Perf: project live execution runs instead of loading every run's `detail` (performance-optimizations item 3).

- New `ExecutionRepository.listLive(workspaceId)` port method returns a lean
  `{ id, blockId, status }` projection of a workspace's LIVE runs (`running`/`blocked`/`paused`)
  without decoding the heavy serialized `detail` column. Implemented on both the D1 and Drizzle
  repos and asserted by the cross-runtime conformance suite.
- `ExecutionService`'s per-service task-concurrency dispatch guard and `resumePaused` now use
  `listLive` instead of `listByWorkspace`, which previously loaded and JSON-decoded EVERY
  historical run in the workspace just to keep the handful of live rows — so the cost now scales
  with concurrency, not unbounded run history.
- Adds the supporting `idx_agent_runs_ws_kind_status` index on `(workspace_id, kind, status)` to
  both runtimes (D1 migration `0048_agent_runs_ws_kind_status.sql` ⇄ Drizzle schema + migration).
- Exposes `listLive` on the mothership-mode persistence allow-list (workspace-scoped read).
