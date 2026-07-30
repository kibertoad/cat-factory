---
'@cat-factory/app': patch
---

Resize a service frame or module by dragging its actual border, and drop the frame's
"N/M implemented" tally.

The resize grips were children of the frame's inner drop zone, which put them 16px inside the
visible border, flush against the task canvas — two thin strips that read as scrollbars rather
than as the frame's edge. They now hang off the card (and the module box) itself, straddling the
border with a 12px hit band centred on it (24px on a coarse pointer) and a 2px bar that lights up
on the border under the pointer, staying lit on the grabbed edge for the whole drag.
`useFrameResize` holds that edge's cursor on `<body>` while dragging so the pointer outrunning the
band no longer reads as a dropped grab, restoring it on `pointercancel` as well as `pointerup`.
The grips are now hidden outright for a read-only viewer instead of lighting up and no-opping.

The frame header's "N/M implemented" line is gone (with the `board.frame.implemented` key, in every
locale): each task card already shows its own status, so the frame-level tally restated that more
coarsely and counted every task ever added to the service rather than the work in flight. The
module and PR-ready counts stay, and the line hides entirely when there are neither.
