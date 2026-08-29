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
a jump to the far side of the board. The bounce is applied locally before the board re-renders,
so an overlap never reaches the screen, and written back through the ordinary move afterwards.
Epics take part alongside frames, being top-level nodes on the same canvas that hide just as much.

Three decisions worth knowing when changing it:

**It lives in the SPA, not the backend.** A frame's footprint is derived from the lane geometry
the browser renders it at; the server stores a position and at most a size override, and cannot
compute the rest. The layer that draws the frames is the only one that can tell whether two
overlap.

**The frame the user is placing is the anchor and never moves; its neighbours do.** The settlement
order is the whole policy, so a deliberate drop lands where it was aimed. A frame ARRIVING on the
board is deliberately not an anchor: it yields to the frames already there rather than shoving
them aside.

**Every client resolves independently, and that is safe** because the resolution is a pure
function of the rects and the anchor order, with tie-breaks fixed in code rather than read off the
board. Two browsers on one board compute the same corrected positions and write the same values
instead of trading them back and forth. The write is held while a drag or border resize is still
running, for the same reason `previewMove` exists, and a read-only viewer gets the corrected view
with no write at all.

`useFrameResize`'s `resizingId` becomes a module-level singleton, matching `useBlockDrag`'s
`draggingId`, so the guard can tell that a border is still under the pointer.
