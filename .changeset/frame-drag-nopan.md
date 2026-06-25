---
'@cat-factory/app': patch
---

Fix dragging services / modules / tasks on the board: grabbing a frame's header (or a
module/task handle, or a resize edge) panned the canvas instead of moving the block.
Vue Flow pans the pane on a left-drag via d3-zoom's `mousedown`, and the custom drag
handles only `stopPropagation` the `pointerdown` event, which can't suppress that
separate `mousedown`. The handles now carry Vue Flow's `nopan` class (its sanctioned
opt-out), so a left-drag from a handle drives the block move/resize while the rest of
the frame still pans the canvas.
