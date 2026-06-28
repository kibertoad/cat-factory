---
'@cat-factory/orchestration': patch
---

ExecutionService split (take 2), phase 3: debag the gate controllers onto the spine
collaborators. `ReviewGateController`, `CompanionController`, `TesterController`,
`HumanTestController` and `VisualConfirmationController` previously each received the SAME
shared state-machine primitives as a fat per-callback bag (`ReviewGateController` alone took
18: `parkStepOnDecision` / `advancePastResolvedGate` / `finishStep` / `startStep` /
`updateBlockProgress` / `finalizeBlock` / `stopRunContainer` / `persistInstance` /
`emitInstance` / `raiseDecisionRequired` / …). They now take the cohesive `stateMachine`
(`RunStateMachine`) + `stepGraph` (`StepGraph`) collaborators instead, so the duplicated
spine wiring is gone and each controller's deps shrink to its own data access plus its
genuinely controller-specific operations. No behaviour change.
