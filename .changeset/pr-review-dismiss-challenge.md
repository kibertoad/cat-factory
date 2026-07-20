---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

PR deep-review: add per-finding **Dismiss** and **Challenge** actions to the review window.

Dismiss drops a finding entirely (pruning it from the selection); the run stays parked. Challenge
dispatches a new read-only `challenge-investigator` agent kind against a single finding — with an
optional specific concern, or a generic "dig deeper + validate" prompt — which re-examines it
against the full source and either strengthens/clarifies the finding (amending its body) or
retracts it (auto-deselecting it and recording a justification shown beside it). The investigator
is its own agent kind, so it can be pointed at a different (stronger) model than the reviewer via a
per-kind model-preset override. All state rides `step.prReview` / `step.pendingChallenge` (no side
table), so it stays runtime-symmetric; the cross-runtime conformance suite asserts dismiss,
challenge-retract and challenge-uphold.
