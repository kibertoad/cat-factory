---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Add per-step human approval gates to pipelines, plus two board polish fixes.

A pipeline step can now be marked "require approval" when building the pipeline
(`Pipeline.gates`, parallel to `agentKinds`; persisted via the new `gates` column,
migration `0023`). When a gated step finishes, the run parks — reusing the durable
decision wait — and a human reviews the step's proposal in an editable modal, then
either **Approves** (the edited proposal advances and flows to downstream steps as
context) or **Requests changes** (the same step re-runs with the human's feedback
folded into the agent's prompt via `AgentRunContext.revision`). New endpoints
`POST /executions/:id/steps/:approvalId/{approve,request-changes}`
(`ExecutionService.approveStep` / `requestStepChanges`). The gate is surfaced on the
board card, inspector, focus view and the zoomed-in pipeline.

The **requirements reviewer** is now an automated, inline pipeline step
(`requirements` agent kind) that runs before the architect instead of a manual
inspector button. The default "Full build" pipeline seeds it first and gates both
the requirements review and the architecture proposal.

Also: the inspector panel now scrolls when its content exceeds the viewport, and
zoomed-in pipeline steps are clickable to reveal the prose conclusion each agent
produced (matching the inspector).
