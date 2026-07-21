---
'@cat-factory/app': patch
---

Surface the PR reviewer's live phase on the board and its run details in the review window.

- Board: a `pr-reviewer` step now shows its precise sub-phase on the task-card mini pipeline
  and the focus-view timeline — "Slicing…" while it groups the diff, "Reviewing X/Y slices"
  while it works through the chunks (plus awaiting / investigating / fixing / posting) —
  instead of a bare N/M subtask count that read like any other agent. The derivation is the
  pure, unit-tested `prReviewPhase` helper rendered by a shared `PrReviewPhaseBadge`.
- PR review window: add the shared run-details sidebar (`StepRunMeta`) — time elapsed, model,
  run id, and the LLM model-activity rollup (calls / tokens) — so the reviewer's run reads the
  same "which run is this / how did the model do" facts as the generic step detail and the
  gate/tester windows.
