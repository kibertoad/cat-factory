---
'@cat-factory/app': patch
---

Board: stop a zoomed-in service from collapsing as you scroll across it. Expanding a
service (or a task's pipeline list) now pushes its neighbours away to reserve room
("compressed space") instead of overlapping them and collapsing one to resolve the
clash. The old greedy "centre-most frame wins any overlap" gate is gone: every on-screen
frame may expand, and a frame stays open while you navigate the whole of it. The
displacement is render-only, so stored block positions are untouched. Zooming out
past the expand threshold recentres the camera on the service it was over, so the
collapsing reserved space doesn't strand you in empty canvas.

The expansion grant is now sticky while you stay zoomed in: a service you've scrolled
past keeps its reserved room instead of collapsing the moment it leaves the viewport,
so scrolling right across one service into the next no longer snaps you forward. The
camera also compensates when expansion would shift what's on screen (a service
entering from the left, or the expansion that fires as you zoom in), anchoring on the
service under the cursor so zooming in lands you on the service you were hovering, not
its neighbour. The result is zero on-screen snapping while navigating at zoom; the
only intended jump is the recentre when you zoom back out.
