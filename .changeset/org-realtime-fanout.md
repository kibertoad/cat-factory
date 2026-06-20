---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Real-time fan-out for shared services.

A shared service can appear on several workspaces' boards, but the engine pushes a live
change (run progress, bootstrap, notification) to only the workspace it addresses — so the
other boards saw the update only on reload. `FanOutEventPublisher` (a decorator over the
per-workspace publisher) resolves the changed block's service and re-publishes the event to
**every** workspace that mounts it, so all boards update live.

- `WorkspaceMountRepository.listWorkspaceIdsMountingBlock(workspaceId, blockId)` (D1 + Drizzle)
  resolves the fan-out's target workspaces — the service owning the block and the boards that
  mount it — in a single join.
- The Cloudflare facade wraps its `DurableObjectEventPublisher` with `FanOutEventPublisher`.
  Best-effort and self-isolating (the persisted row stays the source of truth); a block with
  no service, or a coarse block-less `boardChanged`, falls back to the originating workspace.
