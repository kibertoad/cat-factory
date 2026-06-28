---
'@cat-factory/orchestration': minor
---

Board mutations now push a real-time `boardChanged` event. Creating, renaming,
moving, reparenting, deleting blocks (and toggling dependencies / epic assignment)
emit a coarse board signal through the `ExecutionEventPublisher`, so every user
active on a workspace — and every board mounting a shared service — sees human
board edits live instead of only after a refresh. Best-effort and a no-op when no
real-time transport is wired.
