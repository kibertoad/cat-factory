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

Two blocks are never carried, on any reason or event. A service FRAME, because one payload is
published for every board that mounts the affected service and a frame's position and size live on
the per-workspace mount rather than on the shared row, so whichever mount a publisher projected
through would be wrong on every other board and would jump the frame to coordinates none of them
shows it at. And a headless `internal` anchor block (a public-API run's own "task"), which the
snapshot read filters out of every board and which would otherwise render as a card carrying the
external caller's brief that no later read can remove. Both are refused once at the wire, by
kernel's `deliverableBoardBlock`, which every block-carrying event on both facades is assembled
through (`boardWireEvent` / `bootstrapWireEvent`) rather than trusted to each emit site.

That makes the `bootstrap` event's frame payload a withheld one too, so a repo bootstrap now
announces its frame's transitions (materialised, ready, blocked) as coarse `board` events beside
the job. The live "bootstrapping…" progress still rides the job with no refresh at all; what
stops is a poll tick pushing frame coordinates that are stale the moment anyone drags the card.

Internal breaks, all pre-1.0 surfaces: `ExecutionEventPublisher.boardChanged` now takes a
`BoardChange` value instead of four positional arguments; the `board` wire event gained `block`;
and the `bootstrap` wire event's `block` is now always null. A client on the old shape sees
`block` as absent and refreshes, which is the behaviour it already had.
