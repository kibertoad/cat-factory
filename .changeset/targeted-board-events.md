---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Patch the board from a `board` event instead of re-fetching the whole snapshot

Every `board` event collapsed to one thing in the SPA: a debounced full `workspace.refresh()`,
which is a REPLACE-style rehydrate of ~20 stores. The backend already knew which block changed
and threw the id away at the publisher, so a spawned task cost the same as a service being
deleted. An initiative loop firing one `block-added` per spawned item put every open board into a
snapshot fetch every ~300ms debounce window, and a board mounting the shared service paid it too.

A `board` event now carries the changed block when the change is FULLY DESCRIBED by that one
block (a spawned task, a module materialising, a field edit, a move, a dependency toggle, an epic
assignment, a cancel), and the SPA upserts it through the same path an `execution` event's block
takes. That path is the one with the monotonic live-upsert stamp on it, so a targeted board
upsert is protected from a slower snapshot resolving on top of it exactly as run transitions
already were.

The change that is NOT fully described by one block keeps the full refresh, and that half is the
point rather than a leftover: a removal cascades over descendants and prunes edges on blocks the
event never names, a reparent moves a subtree between parents, a resize shifts children, a
blueprint reconcile rewrites a whole service. A payload there would state part of the change and
read as all of it.

A service FRAME is never carried, on any reason. One payload is published for every board that
mounts the affected service, and a frame's position and size live on the per-workspace mount
rather than on the shared row, so whichever mount a publisher projected through would be wrong on
every other board and would jump the frame to coordinates none of them shows it at. That is the
failure `applyMountLayout` exists to prevent, arriving through a door it does not cover, so the
rule is enforced once at the wire (kernel's `deliverableBoardBlock`, which both facades project
through) rather than trusted to each emit site.

Internal breaks, both pre-1.0 surfaces: `ExecutionEventPublisher.boardChanged` now takes a
`BoardChange` value instead of four positional arguments, and the `board` wire event gained
`blockId` and `block`. A client on the old shape sees `block` as absent and refreshes, which is
the behaviour it already had.
