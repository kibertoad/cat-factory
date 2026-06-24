---
'@cat-factory/app': patch
---

Render a failed run's mid-flight agent as "Failed" with a red cross, not "Working".

A step (or gate helper like the conflict-resolver) left in `working` state when its
run terminates as `failed` used to keep showing the "Working" label and a frozen
loader in the inspector, the focus-view pipeline, and the board card drill-down. It
now reads "Failed" with a red cross (`i-lucide-circle-x`), and a gate companion caught
mid-run reports "Gave up" instead of "Running". Centralised the shared verdict in
`pipelineRender` (`isFailedStep`, `FAILED_STEP_META`, a `failed` `CompanionState`).
