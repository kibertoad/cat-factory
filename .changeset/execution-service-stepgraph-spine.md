---
'@cat-factory/orchestration': patch
---

ExecutionService split (take 2), phase 1: extract `StepGraph` — the pure, synchronous
step/cursor mutators (`startStep` / `finishStep` / `pauseStepForInput` / `resetStepForRerun`
plus the companion rework loop `companionProducerIndex` / `rerunProducerThrough` /
`loopCompanionProducer`) — into its own collaborator (`execution/StepGraph.ts`, constructed
with just a `Clock`). The engine now delegates to `this.stepGraph.*`. This is the
dependency-free inner layer of the run state-machine spine: lifting it gives the engine and
every gate controller ONE definition of the step-timing rules instead of each receiving them
as a loose callback bag (the debagging lands in a later phase). No behaviour change.
