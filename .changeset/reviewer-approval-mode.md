---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Unify the approval gate into the conclusions reader, with GitHub-style review.

The dedicated approval modal is gone. A pending gate now opens the same polished
step-detail reader (ToC side nav, rendered markdown), in a new **approval mode**:
the reviewer can comment on individual blocks of the agent's output (click a block —
the rendered markdown carries `data-src-start/end` source ranges so the comment
quotes that block's verbatim raw markdown), leave overall freeform feedback, then
**Approve** (advance), **Request changes** or **Reject**.

- **Request changes** re-runs the step with both the freeform feedback and the
  per-block comments folded into the agent's prompt (`AgentRunContext.revision`
  gains `comments`; `requestStepChangesSchema` now takes `feedback?` + `comments?`,
  requiring at least one).
- **Reject** stops the run entirely — a terminal `rejected` failure
  (`agentFailureKindSchema`), so the board's shared failure banner + retry surfaces
  it (block → `blocked`). New `POST /executions/:id/steps/:approvalId/reject`
  (`ExecutionService.rejectStep`).
- `stepApprovalSchema` gains the `rejected` status and a persisted `comments` array
  (`stepReviewCommentSchema`). No migration: approvals live in the execution
  `detail` JSON.

Cross-runtime conformance gains assertions for reject and comment-driven re-runs.
