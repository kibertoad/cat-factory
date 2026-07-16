---
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
---

feat(spike): make the spike task type functional — the `spike` agent kind, the `pl_spike` pipeline, and the type default

A `spike` task is a timeboxed investigation whose deliverable is a findings document — no code, no PR. Until now the type was a hollow shell behind the create form: it dispatched a full code-build pipeline. This lands the happy path (Phase A of the spike-task-support initiative):

- **New `spike` agent kind** (`@cat-factory/agents`): a read-only `container-explore` kind registered through the public `registerAgentKind` seam (the `bug-investigator` / `environment-analyst` shape). It clones the primary repo read-only, investigates the brief + linked context + codebase, and returns structured findings (question, findings prose, options compared, recommendation, open questions, confidence) rendered through the shared `generic-structured` result view. The read-only guardrail and final-answer-in-reply directives are applied automatically for a container-explore kind. It folds the spike's creation criteria — the existing `researchQuestion` / `optionsToCompare` keys and the previously-inert `timeboxHours` (now a scope-discipline directive) — into its prompt.
- **New `pl_spike` pipeline + type default** (`@cat-factory/kernel`): `seedPipelines()` gains `pl_spike` (an opt-in, off-by-default `requirements-review` gate → the `spike` agent), and `defaultPipelineIdForTaskType('spike')` now returns it, so a spike task pins the investigation pipeline instead of falling through to the full code-build. The read-only `spike` step opens no PR, so the run terminates cleanly via the existing no-PR terminal path in `RunStateMachine.finalizeBlock`.
