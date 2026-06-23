---
'@cat-factory/orchestration': patch
---

Continue decomposing the `ExecutionService` engine by extracting three flow-control
collaborators (behaviour-preserving):

- **`MergeResolver`** — resolves a `merger` step's assessment into an auto-merge (within
  the task's threshold preset AND credibly explained) or a `merge_review` notification.
- **`CompanionController`** — drives a companion (reviewer / spec / architect) step: grade
  the producer, then pass / loop the producer back / park on the iteration-cap gate; an
  unparseable verdict fails the run rather than silently passing.
- **`TesterController`** — drives the Tester gate's fix loop: apply the report (greenlight →
  advance; withheld + budget → dispatch the fixer and re-test; spent/unparseable → fail).

Each collaborator owns its cohesive logic; the shared engine primitives they need
(`resolveMergePreset`, `finalizeMerge`, `parkStepOnDecision`, `loopCompanionProducer`, the
instance persistence/emit, container reclaim) stay on the engine and are injected. The
engine's public surface and behaviour are unchanged. Trims ~540 lines from
`ExecutionService` (now ~3,280, down from ~4,100 at the start of this decomposition).
