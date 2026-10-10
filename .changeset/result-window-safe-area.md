---
'@cat-factory/app': patch
---

Result windows keep clear of a phone's notch and home indicator, and their scroll areas no longer
chain into the page.

The shared `ResultWindowShell` now insets every window by the larger of 1rem and the device's
safe-area inset on each side, so a full-height window's header no longer sits under the notch.
Every scroll container and text area inside a window gets `overscroll-behavior: contain`, so
scrolling past the end of a list on a phone no longer triggers pull-to-refresh and reloads the app.
