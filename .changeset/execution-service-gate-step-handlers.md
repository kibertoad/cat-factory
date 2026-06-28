---
"@cat-factory/orchestration": patch
---

ExecutionService split, phase 4: lift the remaining `stepInstance` dispatch branches
(the four review/brainstorm gates, human-test, visual-confirm, the polling gates, and
inline companions) into dedicated `StepHandler`s with explicit `order` preserving the
original precedence. `runStepBody` now holds only the generic container/inline-agent
fallthrough. Behaviour-preserving; verified on both runtimes.
