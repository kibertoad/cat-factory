---
'@cat-factory/app': patch
---

Make "Restart from here" reachable from every pipeline step window.

The restart-from-step control was only wired into the generic prose step panel
(`AgentStepDetail`), but several common step kinds — `tester`, the `ci`/`conflicts`
gates, and `requirements-review` — open DEDICATED result windows (`TestReportWindow`,
`GateResultView`, `RequirementsReviewWindow`) via the `resultView` seam, which never
got the button. So when a user zoomed into a pipeline and clicked one of those steps,
no "Restart from here" affordance appeared at all.

Extracted a shared `StepRestartControl` (the same two-click confirm + gating: hidden
for an off-path open with no run, or while THIS step is parked on an unresolved
approval gate) and dropped it into all four step windows, so restart is now reachable
from every step a human can click into. No backend change — the existing
`POST …/executions/:id/restart` endpoint and store action are unchanged.
