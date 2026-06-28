---
'@cat-factory/app': patch
---

Make the board shell responsive on phones (phase 1 of the mobile-friendly work). Below
`lg` (1024px) the navbar collapses into an off-canvas drawer toggled by a hamburger, the
inspector panel becomes a bottom sheet with its existing close button as the dismiss
affordance, the board toolbar collapses its labels to icons so it never overflows, and the
notifications popover is capped to the viewport width. Adds a shared `useViewport`
composable (`isCompact`/`isTouch`) and a `mobileNavOpen` flag on the UI store.
