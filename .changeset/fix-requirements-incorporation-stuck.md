---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Fix the async requirements incorporation getting stuck "incorporating" forever, and visualize
the reviewer's two background stages on the board.

The async incorporate/re-review cycle could hang permanently: `incorporateRequirements`
signalled the durable driver to wake but left the run `blocked` from the gate park, and
`advanceInstance` no-ops on any non-`running`/`paused` run — so the woken driver returned
`noop` and ended WITHOUT running the re-entrant fold + re-review, leaving the review stuck
`incorporating`. It now re-arms the run to `running` before signalling, exactly like every
other resume path (e.g. `advancePastResolvedGate`).

The cycle also now reports its two stages distinctly. A new transient `reviewing` review
status is set (and pushed via `requirementReviewChanged`) once the answers are folded and
the reviewer is RE-reviewing the document, so the UI can tell which of the two LLM calls is
running instead of one conflated "incorporating and re-reviewing" message.

- **Board / inspector.** A `requirements-review` gate that is mid-cycle (`incorporating` /
  `reviewing`) no longer shows the "Approval needed" badge or the "Review & approve" button
  on the task card, frame badge, or inspector step list — it shows a working indicator
  ("Incorporating answers…" / "Re-reviewing…") instead, since no human action is needed
  until the reviewer comes back.
- **Review window.** The single background banner is split into two distinct messages keyed
  on the stage, and edits stay frozen during both.

Breaking (pre-1.0, no migration): the new `reviewing` review status is a new wire value;
the `status` column is free text on both runtimes, so no schema change is required.
