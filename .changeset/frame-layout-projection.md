---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/workspaces': patch
---

Fix a service frame jumping to a different spot on the board right after it is resized (and after
any other frame edit, including a rename or an archive/restore). A frame's board position is a
per-workspace layout override carried on its mount, so the shared block row keeps whatever
coordinates it was created with — but the single-block mutation responses were built straight from
that row, and the SPA upserts the authoritative block a mutation returns. Frame-returning reads now
project through the same `applyMountLayout` the board snapshot uses. Importing a repo that already
backs a shared service likewise returns the frame placed where this board just mounted it, instead
of at the home board's coordinates.
