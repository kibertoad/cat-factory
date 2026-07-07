---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Planning-interview questions gain the same answer surface as requirements review, via a shared
clarification-item abstraction (see `docs/initiatives/clarification-items.md`).

A planning question can now be marked **not relevant** (dismissed — it stops blocking Continue and
the interviewer is told not to re-ask it) and the human can ask the interviewer to **recommend** a
suggested answer (drafted inline, adopted with "use this answer"). These reuse a new shared
`ClarificationItem` component rather than cloning the requirements UI. `InitiativeQa` gains
`status` + `recommendation`; no DB migration (the initiative persists as a JSON blob, so both
runtimes pick up the fields for free). The initiative board card also pulses while its interview is
awaiting answers, matching how a review gate surfaces attention on a task card.
