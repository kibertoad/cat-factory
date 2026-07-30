---
'@cat-factory/app': patch
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Resize a service frame or module by dragging any of its borders, and drop the frame's
"N/M implemented" tally.

The resize grips were children of the frame's inner drop zone, which put them 16px inside the
visible border, flush against the task canvas — two thin strips that read as scrollbars rather than
as the frame's edge — and only the east/south borders had one at all. All eight borders and corners
are now grips on the box itself (a shared `ResizeGrips.vue`, so the frame and the module can't
drift), each straddling the border it moves: a 12px hit band centred on it, 24px on a coarse
pointer, with a 2px bar that lights up on the border under the pointer and stays lit on the grabbed
border for the whole drag. `useFrameResize` holds that border's cursor on `<body>` while dragging so
the pointer outrunning the band no longer reads as a dropped grab, restoring it on `pointercancel`
as well as `pointerup`. The grips are hidden outright for a read-only viewer instead of lighting up
and no-opping.

Dragging the north or west border moves the container's content origin, and a child's position is
stored relative to that origin, so the contents have to be translated the other way or they slide
with the border. `POST /blocks/:id/resize` (new) carries both halves of the geometry and does that
in one arithmetic UPDATE via the new `BlockRepository.shiftChildPositions` (D1 + Drizzle, with
cross-runtime conformance assertions); the SPA applies the same compensation optimistically during
the drag and replays it inverted if the write is rejected.

Fixes a latent bug this surfaced: `BoardService`'s frame-mount resolution looked a frame block id
up globally (`getByFrameBlock`), while every read resolves layout from the board's own mounts. Since
seeded boards all carry the same block ids, a deployment with two of them could resolve another
board's service, land the write on the block row, and have every read override it with this board's
mount. It now resolves in the same direction the snapshot does.

The frame header's "N/M implemented" line is gone (with the `board.frame.implemented` key, in every
locale): each task card already shows its own status, so the frame-level tally restated that more
coarsely and counted every task ever added to the service rather than the work in flight. The module
and PR-ready counts stay, and the line hides entirely when there are neither.
