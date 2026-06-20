---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/server': minor
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
- A **mount API**: every newly created service frame is registered as an
  account-owned service and mounted onto its workspace; `GET /workspaces/:ws/services`
  (mounts), `GET /workspaces/:ws/services/catalog` (the org's services),
  `POST|DELETE /workspaces/:ws/services/:serviceId` (mount/unmount — within the same
  org only), `PATCH …/layout` (per-workspace frame layout). Backed by the new
  `ServiceMountService` (orchestration `services` module) wired into both runtimes.

- **Board composition**: a workspace's board snapshot is now composed from the
  services it mounts — its own blocks plus the full subtree of any service mounted
  from another workspace in the same org, so a shared service renders identically on
  every board (one physical copy ⇒ one shared task list + state). Each externally
  mounted frame is positioned by this workspace's mount (the per-workspace layout
  override), while a locally homed frame keeps its own movable position. Block inserts
  stamp `service_id` (the frame's service for a frame; the enclosing frame's service
  for tasks/modules) so the subtree is `listByService`-discoverable everywhere.

Sync deduplication, real-time fan-out to all mounting workspaces, and the frontend
land in follow-up increments.
