---
"@cat-factory/orchestration": patch
"@cat-factory/kernel": patch
---

ExecutionService split, phase 2: add a `phase` discriminator to the `StepCompletionResolver`
seam (`terminal` default vs a new `post-completion` early slot) and migrate the inline
blueprint/spec/task-estimate ingestion branches of `recordStepResult` into `post-completion`
resolvers. The early slot runs before the follow-up/approval gates read `step.output`, so the
task-estimate summary still drives the approval proposal. The kind-agnostic PR-writeback and
reviewable-artifact-output branches stay inline. Behaviour-preserving; verified on both runtimes.
