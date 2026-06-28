---
'@cat-factory/app': patch
---

Make the board canvas usable by touch (phase 3 of the mobile-friendly work). On a coarse
pointer the Vue Flow pane now pans with one finger and zooms with a pinch: `panOnDrag` is
widened from the precise-pointer button list (`[0, 2]`) to `true` on touch — the button-array
form silently blocked single-finger panning because a touch `touchstart` carries no
`event.button` — while mouse desktops keep the left/right-drag (never middle) restriction.
The pane gets `touch-action: none` and every custom drag/resize/connect affordance (task drag
grip, service/module header + resize edges/corner, drag-to-connect handle) gets `touch-none`,
so a gesture is owned by the board instead of being stolen mid-drag by the browser as a page
scroll (which fires `pointercancel`). The minimap — a precise-pointer affordance that's too
small to hit and eats scarce width on a phone — is hidden below `lg`; the toolbar's
zoom-out / zoom-in / fit-view controls remain the camera fallback.
