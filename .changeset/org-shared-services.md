---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

In-org shared services: schema + domain foundation.

Introduce the account-owned **service** as the canonical board unit and the
**workspace mount** that places it onto a workspace's board, so the same service
can appear on several workspaces in one org without duplicating its subtree, state
or sync. This is the first (additive) increment:

- New wire types `Service` + `WorkspaceMount` (`@cat-factory/contracts`) and the
  `ServiceRepository` / `WorkspaceMountRepository` ports (`@cat-factory/kernel`).
- New `services` + `workspace_services` tables on both runtimes (D1 migration
  `0030`; Drizzle migration for Postgres), with an idempotent backfill that turns
  every existing top-level frame into an account-owned service mounted into its
  current workspace at its current board position.
- D1 + Drizzle implementations of the two repositories.
- A `service_id` column denormalised onto `blocks` + `agent_runs` (D1 migration
  `0031`; Drizzle migration), backfilled via a recursive CTE from each block's
  top-level frame, in preparation for re-keying the board's physical scope.

Existing workspace-scoped behaviour is unchanged; the read paths, mount API,
sync deduplication and real-time fan-out land in follow-up increments.
