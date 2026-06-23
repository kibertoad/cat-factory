---
'@cat-factory/app': patch
---

Remove the redundant manual "Review requirements" entry points. The reviewer now always
runs automatically as the first pipeline gate step, so the inspector panel's "Review
requirements" button and the review window's "Run review" button (and the dead
`requirements.review` store action + `reviewRequirements` API client they used) are gone.
The window's empty state now explains the reviewer runs automatically when the task's
pipeline starts; the inspector still probes the review so a task's description can freeze
in favour of the reworked requirements document.
