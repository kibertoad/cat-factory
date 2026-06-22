---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
---

Fix companion (Spec Reviewer) ratings being silently reported as 100%.

A companion's structured comments anchor to an item id (`{anchorId, body}`) and
carry no `quotedSource` — exactly the shape `companionSystemPrompt` asks for. But
`stepReviewCommentSchema` required `quotedSource`, so `parseCompanionAssessment`
threw on every real Spec Reviewer reply that included comments, and
`evaluateCompanion` fell back to its pass-through rating of `1`. The result: a
reviewer that rated a spec 55% surfaced as "100% ≥ 80%" and the run advanced past
the quality gate instead of reworking the spec.

`quotedSource` is now optional on `stepReviewCommentSchema` (the human
request-changes path still sends it; an anchor-based companion comment omits it),
so anchor-only assessments parse and the real rating drives the gate. The
`FakeAgentExecutor` now emits anchor-based comments when it downrates, so the
cross-runtime conformance suite exercises the actual parse and guards the
regression (the verdict must carry the critic's real rating, not the fallback `1`).
