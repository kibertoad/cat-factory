---
'@cat-factory/app': patch
---

Two requirements-review / failed-run UI fixes.

When a run fails, the step left mid-flight keeps `state: 'working'`, so the step-detail
overlay's State badge still read "Working". It now reads "Failed" (red) for a working
step on a failed run, matching the rest of the failure surface.

While an iterative reviewer gate (requirements-review / clarity-review) folds answers /
re-reviews in the background, no human is needed, so its parked approval must not invite
action. `PipelineProgress` and `TaskPipelineMini` now suppress the "Review & approve"
button during that background stage (showing a working indicator in the focus pipeline),
matching the suppression already done in `BlockNode`, `TaskCard`, and `TaskExecution`.
