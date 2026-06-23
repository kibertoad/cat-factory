---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Surface CI and conflict gate conclusions in the run-detail UI through one universal gate
window.

The polling gates (`ci`, `conflicts`) already tracked phase/attempts/headSha on
`step.gate`, but the frontend type didn't even declare the field, so none of it rendered —
and the gates' actual conclusion (which CI checks failed, whether the PR conflicts) was
computed in `evaluateGate` only to be handed to the helper agent and then discarded. A
user opening a CI or Conflicts step saw a generic prose panel with nothing about why the
gate was looping.

Backend: `gateStepStateSchema` now persists the precheck outcome — `lastVerdict`,
`lastFailureSummary`, and (CI only) the structured `failingChecks` list — written on every
probe in `evaluateGate` and preserved across the helper dispatch. Gate state lives in the
execution `steps` JSON, so both runtimes pick this up with no migration. (The conflicts
gate carries no structured detail because GitHub reports mergeability as a single verdict,
not a file list.)

Frontend: a single `GateResultView` window, registered on the shared `resultView` seam for
both the `ci` and `conflicts` kinds, shows the verdict, the helper attempt budget, the
gated commit, and — for CI — the failing checks. The two board views (`TaskExecution`,
`PipelineProgress`) now also render each gate's helper (`ci-fixer` / `conflict-resolver`)
as a possible/running/completed/skipped sub-node, the same treatment the Tester's fixer
already had.
