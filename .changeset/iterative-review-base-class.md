---
'@cat-factory/orchestration': patch
---

Collapse the requirements-review and clarity-review services onto a shared
`IterativeReviewService` base class. The two services ran the same iterative loop
(reviewer raises findings → human answers/dismisses → incorporation LLM folds them
into a standardized document → re-review until convergence or the iteration cap),
duplicated across ~1,000 lines. The loop now lives in one place; each kind supplies
only its differentiators (subject + prompts, the persisted document field —
`incorporatedRequirements` vs `clarifiedReport` — id prefixes, agent-kind tags and
notification type). Pure refactor: the public method signatures, wire contracts,
persisted tables and behaviour are unchanged.
