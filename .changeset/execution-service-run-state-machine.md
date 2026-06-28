---
'@cat-factory/orchestration': patch
---

ExecutionService split (take 2), phase 2: extract `RunStateMachine` — the async
instance/block state-machine spine (`execution/RunStateMachine.ts`), composing `StepGraph`.
It owns everything the engine and every gate controller share about MOVING a run:
`persistInstance` / `emitInstance` (+ the metrics rollup, Kaizen scheduling and terminal
personal-credential cleanup), `updateBlockProgress` / `refreshBlockProgress`,
`parkStepOnDecision` / `advancePastResolvedGate`, `finalizeBlock`, `failRun`,
`stopRunContainer`, and the park-related notifications (`raiseDecisionRequired` /
`ensureWaitingNotification` / `clearWaitingNotification`). `ExecutionService` now delegates
(its public `failRun` is a thin pass-through, preserving the driver-facing API).

The merge/auto-start subgraph (`finalizeMerge` / `applyModuleAssignment` /
`autoStartDependents`) deliberately stays on the engine — `finalizeBlock` here only flips
block status and raises the no-merger notification, so this layer carries no merge
collaborators. With phase 1's `StepGraph`, the spine the previous attempt left scattered as
private methods (and handed to each controller as a fat callback bag) now has one cohesive
home; debagging the controllers onto it is the next phase. No behaviour change — methods
moved verbatim, replay-correctness invariants (persist→emit ordering, set-once timestamps,
`runId` stamping) preserved.
