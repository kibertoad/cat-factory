---
'@cat-factory/app': patch
---

Full-screen overlays keep clear of a phone's notch and home indicator, and dragging inside one no
longer reloads the app.

The result window shell now insets every window by the larger of 1rem and the device's safe-area
inset on each side, and caps a centered window at the padded height, so a full-height window's
header no longer sits under the notch. The step detail reader and the model configuration takeover
pad by the inset alone. `html` and `body` set `overscroll-behavior-y: none`, so a vertical drag
that reaches the viewport no longer triggers pull-to-refresh, which reloaded the app and dropped the
open window. Inner scrollers still hand the scroll on to the scroller around them.
