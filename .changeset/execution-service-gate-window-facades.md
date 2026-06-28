---
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
---

ExecutionService split (take 2), phase 5: group the gate-window actions into per-feature
sub-facades. The dedicated review/test windows drove a parked gate through ~30 near-identical
3-line delegations on `ExecutionService` (`reviewRequirements` / `incorporateClarity` /
`proceedBrainstorm` / `confirmHumanTest` / `approveVisualConfirm` / …), bloating its public
surface. They are now grouped into cohesive sub-facades exposed as getters on the still-injected
`executionService` — `.requirementsReview` / `.clarityReview` / `.brainstorm` / `.humanTest` /
`.visualConfirm` — and the matching server controllers call through them
(`executionService.requirementsReview.review(...)` etc.). The composition roots are untouched
(the single `executionService` is still what every facade injects), so the runtimes stay
symmetric. No behaviour change.
