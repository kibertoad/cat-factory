---
'@cat-factory/app': patch
---

feat(app): board zoom/canvas navigation papercuts (UX-07/08/09/14/15/16)

Burns down the board zoom-control cluster from the UX papercuts initiative:

- The three toolbar zoom controls (`zoom out` / `zoom in` / fit-to-content) now route
  through the shared `IconButton` primitive with accessible labels applied as both
  `title` and `aria-label`, so the ambiguous `maximize` glyph is finally named (UX-08).
- The `%`/LOD readout is a real `<button>` that snaps the camera back to 100%
  (`resetZoom` → `zoomTo(1)`), and it's always visible now — only the LOD sub-label
  drops below `sm` (UX-14, UX-15).
- Zoom in/out buttons disable at the min/max clamps, now sourced from shared
  `BOARD_MIN_ZOOM`/`BOARD_MAX_ZOOM` constants consumed by both the canvas and the
  button-disable logic so they can't drift (UX-16).
- Double-clicking a service frame focuses it (centre + zoom in) instead of calling the
  inert `toggleFrame` no-op (UX-09).
- Dropping a pipeline on blank canvas (or a non-task) now shows the "aim at a task"
  nudge instead of silently vanishing (UX-07).
