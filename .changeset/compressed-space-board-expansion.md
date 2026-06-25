---
'@cat-factory/app': patch
---

Board: stop a zoomed-in service from collapsing as you scroll across it. Expanding a
service (or a task's pipeline list) now pushes its neighbours away to reserve room
("compressed space") instead of overlapping them and collapsing one to resolve the
clash. The old greedy "centre-most frame wins any overlap" gate is gone: every on-screen
frame may expand, and a frame stays open while you navigate the whole of it. The
displacement is render-only, so stored block positions are untouched.
