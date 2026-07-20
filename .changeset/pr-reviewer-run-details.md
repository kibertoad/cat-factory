---
'@cat-factory/orchestration': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
---

feat: surface live PR-review progress instead of a bare "agent running"

A running `pr-reviewer` deep review now shows what it is actually doing rather than a generic
"agent running" spinner. Two gaps closed:

- The `reviewing` status existed on `step.prReview` (and `recordFindings` already guarded for it)
  but was never assigned — so during a run the deep-review window had no state to render. The
  engine now SEEDS `step.prReview = { status: 'reviewing', prUrl, model, … }` (via the new pure
  `initialPrReviewState` helper) the moment the reviewer's container job dispatches, so the window
  renders a real reviewing phase carrying the reviewed PR and model. A `fix`/`post` re-dispatch is
  untouched (it already carries `fixing`/`posting` state). Runtime-symmetric — state rides the
  step, no table.

- The reviewer's prompt now instructs it to maintain a per-slice todo list (one entry per cohesive
  chunk it groups the diff into, plus a final "aggregate findings" entry) and mark each done as it
  finishes. That surfaces as the step's live `subtasks`, which the deep-review window now renders
  during `reviewing`: a "slices reviewed / total" count, a progress bar, and the chunk breakdown
  with per-item status — instead of a static spinner. It degrades gracefully to the spinner before
  the reviewer has planned its slices.
