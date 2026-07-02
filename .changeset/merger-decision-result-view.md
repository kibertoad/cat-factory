---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Surface the merger's verdict as a structured decision instead of raw JSON.

The engine now records a `MergeDecision` on the completed `merger` step (`step.custom`): the
assessment scores, the resolved preset ceilings, and — crucially — whether it auto-merged or routed
the PR to a human, and WHY (`within_thresholds` / `exceeded_thresholds` / `auto_merge_disabled` /
`no_assessment` / `merge_failed`). The SPA renders it in a dedicated `MergerResultView` (complexity /
risk / impact bars vs their ceilings + a plain-language decision banner — "Auto-merged — every score
is within the Balanced thresholds" / "Awaiting human review — risk exceeded the thresholds") instead
of the agent's raw JSON.

Also fixes the inspector showing a finished merger step as "Agent running": the run's shared container
is kept alive until the pipeline's final step, so a step whose state is already `done` (the merger
resolving mid-pipeline before a trailing gate) no longer displays the stale live container-phase label.
