---
"@cat-factory/orchestration": patch
"@cat-factory/kernel": patch
---

ExecutionService split, phase 3: lift the container-companion and tester verdict
short-circuits out of `recordStepResult`'s inline top into an engine-internal
`StepCompletionInterceptor` seam (`canIntercept` + `intercept → AdvanceResult | null`,
sibling to `StepHandler`), dispatched at the top of `recordStepResult`. Remove the
unused `control` field from the kernel `StepResolution` (superseded by the interceptor,
which returns a full `AdvanceResult` the bare enum couldn't carry). Behaviour-preserving;
verified on both runtimes.
