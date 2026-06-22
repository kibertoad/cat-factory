---
'@cat-factory/app': patch
---

Fix the requirements-review window showing empty results when opened from a pipeline step
("Requirements Reviewer") or the focus view's "Review & approve" button, and stop a
task-card click from popping the review open.

The window is mounted fresh by `StepResultViewHost` every time it opens, but its block
watch wasn't `immediate`, so the initial `load()` fetch never ran — the review only
appeared when the cache had already been warmed by selecting the task (which the task-card
path did first, but the pipeline-step path did not). The watch is now `immediate`, so the
window loads its review on open regardless of entry point.

Clicking a task card now only selects the task (opening the inspector to interact with it)
instead of also opening whatever it's parked on; the decision/approval/review is opened
explicitly via the card's action button.

The store also coalesces overlapping `load()` calls for the same block, so the inspector
badge watch and the review window opening together share one request instead of two.

The `resultView` seam contract (open/blockId/close + Escape + load-on-open) is now a shared
`useResultView` composable that both result windows build on, so a future custom window
can't reintroduce the route-dependent empty state: it declares an `onOpen` loader that
fires on every open regardless of how the window was navigated to.
