---
'@cat-factory/app': patch
---

Make dragging tasks between containers reliable. Tasks can now be dropped into a
module, moved between modules, or pulled back out to the service — previously the
reparent silently no-op'd because the drag handle (which sits in the task's wrapper
above the card) stayed hit-testable, so the drop always resolved to the task's
current container. The whole dragged task is now non-interactive while dragging, so
`elementFromPoint` resolves the zone actually beneath the cursor.

Also stop tasks jumping after a drag. Position is now previewed locally during the
drag and persisted with a single write on release, instead of firing one move
request per pointer event — the old burst raced, and an out-of-order response could
land a stale position last and snap the block back (worst when dragging far, e.g.
toward the end of a service frame). A reparent now also optimistically drops the
block into its new container so it doesn't briefly flash back to its old home.
