---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Make in-org shared boards fully interactive, and tighten the shared-service model.

A workspace that MOUNTS a service from another workspace can now edit it like its own: a
shared service's blocks live in one home workspace, and board mutations resolve them there
(authorized by the mount) instead of 404ing on the workspace-scoped lookup.

- `BlockRepository.findById` (D1 + Drizzle) resolves a block by id across the org; `BoardService`
  uses it so `updateBlock`, `moveBlock`, `addTask`, `addModule`, `removeBlock`,
  `toggleDependency` and `reparent` act on the shared copy at its home workspace. A frame move
  writes the requesting board's mount layout (per-workspace), leaving the shared block untouched.
- Cross-service `reparent` across two services homed in **different** workspaces moves the
  subtree's block rows (and any executions on them) to the destination service's home, re-stamped
  with the destination service — preserving the "a service's blocks live in its home" invariant.
- **Every** top-level frame now registers as an account-owned service via the shared
  `registerServiceForFrame` helper — including **seeded demo boards** and **repo bootstrap**, which
  previously created unshareable, unbadged frames.
- Executions and bootstrap runs now stamp `service_id` from their block at write time (D1 +
  Drizzle), so a shared service's **live** runs surface on every board that mounts it — not just
  pre-migration rows. `BootstrapJobRepository.listByService` + `BootstrapService.listJobs` compose
  a mounted service's in-flight bootstrap into the snapshot.
- Real-time `boardChanged` now carries the affected block, so `FanOutEventPublisher` fans
  structural changes (module materialised, run cancelled, bootstrap finished) out to every
  mounting board live, not just on reload.
- `services.frame_block_id` is now UNIQUE (D1 + Drizzle), enforcing the 1:1 frame↔service mapping.
- Removed N+1s on the snapshot hot path (`composeBoard`) and the GitHub sync fan-out
  (`linkedWorkspaces`).

The Node facade wires the service repos into the engine but, lacking a real-time transport,
does not yet decorate its publisher with `FanOutEventPublisher` (noted in its container).
