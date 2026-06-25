---
'@cat-factory/app': patch
---

Board: make zoom navigation predictable. Service frames are now always expanded to
their task canvas at every zoom level, so the layout is fixed — panning never shifts
it and zooming has no expand/collapse transition, which removes the snap-back where
scrolling across one service or zooming in toward another would throw you onto a
neighbour. Frames are spaced apart with compressed space (an expanded frame pushes its
neighbours away by its growth) so they never overlap; the offset is render-only and
stored positions are untouched.

Task cards inside a service keep the older "centre-most wins" gating: when two expanded
pipeline lists would overlap, the card closest to the screen centre expands and the
other stays compact until you scroll it closer. The per-pan camera compensation, sticky
frame grants, and the on-screen frame-expansion driver are gone.
