---
'@cat-factory/app': patch
---

Make the board canvas usable by touch (phase 3 of the mobile-friendly work). On a
touch-capable surface the Vue Flow pane now pans with one finger and zooms with a pinch:
`panOnDrag` is widened from the precise-pointer button list (`[0, 2]`) to `true` — the
button-array form silently blocked single-finger panning because a touch `touchstart`
carries no `event.button` — while pure-mouse desktops keep the left/right-drag (never
middle) restriction. The switch is gated on `any-pointer: coarse` (so touchscreen laptops
and 2-in-1s, whose primary pointer is the trackpad, also get finger-panning) and lives in a
unit-tested pure helper. The pane gets `touch-action: none` and every custom
drag/resize/connect affordance (task drag grip, service/module header + resize edges/corner,
drag-to-connect handle) gets `touch-none`, so a gesture is owned by the board instead of
being stolen mid-drag by the browser as a page scroll (which fires `pointercancel`). The
minimap is removed altogether — a precise-pointer affordance that's too small to hit on
touch and a width hog on narrow windows, it earned its keep on neither desktop nor mobile;
the toolbar's zoom-out / zoom-in / fit-view controls are the camera navigation on every
viewport.
