---
'@cat-factory/app': minor
---

Keep board frames from overlapping: two that come to overlap now bounce apart

Frames were rendered exactly where they were stored and allowed to overlap freely, with
hover-driven stacking as the only way to reach the one underneath. That works for the frame you
are pointing at and for nothing else: a service parked under a neighbour was invisible, and
nothing on the board said it was there. The invariant "a frame is fully visible" was therefore
true of a board nobody had touched and of no other.

Placement was already refusing to CREATE an overlap (`findFreeFramePosition` nudges a dropped
frame off anything it lands on), which is why this read as a drag-only problem. It is not. Three
events make an overlap after placement, and only one of them is a drag: a frame dragged onto a
neighbour, a border drag growing one into another, and a frame growing ON ITS OWN when its first
task arrives, since an empty service renders the "add the first task" panel and reserves a much
smaller footprint than one rendering lanes.

So the fix is a standing invariant rather than a check bolted onto each of those writes.
`useFrameOverlapGuard` watches the rendered geometry of every top-level board node and, whenever
two come to overlap, bounces them apart through the new pure `resolveFrameOverlaps`: each node is
pushed out along the axis of least penetration, so a small overlap costs a small move rather than
a jump to the far side of the board. The bounce is applied before the board re-renders, so a
settled overlap never reaches the screen. Epics take part alongside frames, being top-level nodes
on the same canvas that hide just as much.

Three decisions worth knowing when changing it:

**It lives in the SPA, not the backend.** A frame's footprint is derived from the lane geometry
the browser renders it at; the server stores a position and at most a size override, and cannot
compute the rest. The layer that draws the frames is the only one that can tell whether two
overlap.

**Correcting the view and writing the correction are separate acts, and only a local gesture
authorises the write.** Every client always draws the board clear, which needs no coordination
because the resolution is pure: two browsers holding one board draw it identically whatever order
their events arrived in, and a read-only viewer gets the corrected view for free. Persisting is the
narrower act, because a drag or border resize is the only cause with an unambiguous single author,
so that client settles the board when the gesture ends and writes what it displaced. A frame that
grows on its own has no author, so its correction is drawn everywhere and written by nobody: that
beats every open session racing to persist the same value, and it behaves better too, since a
projected neighbour is recomputed off the server's own geometry when the frame shrinks again while
a persisted one would stay pushed.

**The settlement order is the whole policy, and it takes at most one anchor:** the node the local
user is placing, held still while its neighbours move aside. A list of anchors would carry an order
of its own, and every order available to build one from is per-client, so two clients would resolve
one overlap to different positions and write over each other. Everything else settles in reading
order, which is positional: the node nearest the top-left keeps its place.

The guard stands down for the whole of a gesture. Bouncing neighbours off the positions a drag
previews displaces frames the user is merely passing over, and the displacement accumulates rather
than springing back, so a drag across a populated board would rearrange services nobody touched.
A frame drawn over its neighbours while the pointer holds it is what direct manipulation looks
like; the board settles on release.

`useFrameResize`'s `resizingId` becomes a module-level singleton, matching `useBlockDrag`'s
`draggingId`, so the guard can tell that a border is still under the pointer.
