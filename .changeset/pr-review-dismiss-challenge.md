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
against the full source and reaches a verdict: `upheld` (kept as written), `amended` (kept and
actually strengthened/clarified), or `retracted` (auto-deselected, struck through, and no longer
actionable — nor re-challengeable). A challenge whose investigator job fails settles the finding
`failed` and re-parks the review rather than failing the whole run, so a crashed second opinion
never nukes the human's in-flight curation. The investigator is its own agent kind, so it can be
pointed at a different (stronger) model than the reviewer via a per-kind model-preset override. All
state rides `step.prReview` / `step.pendingChallenge` (no side table), so it stays runtime-symmetric;
the cross-runtime conformance suite asserts dismiss, challenge-retract, challenge-uphold-strengthen,
challenge-uphold-as-is, and challenge-investigator-failure.
