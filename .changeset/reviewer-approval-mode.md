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

- **Approve with corrections** opens an inline editor over the conclusions; the
  human's edits become the approved proposal carried forward (the existing
  `approveStep` proposal override — no backend change). Manual edits are a distinct
  mode and can't be combined with per-block comments / request-changes — they only
  happen _together with_ approving.

The review surface is responsive — a right-side rail on wide screens, a bottom
sheet below `lg` — so a pending gate is always actionable. Reject uses a two-step
inline confirm (no native dialog). `requestStepChanges`/`rejectStep` reject a stale
gate id whose step is already being re-run (`changes_requested`) so a double-submit
can't dispatch duplicate work.

Cross-runtime conformance gains assertions for reject and comment-driven re-runs.
