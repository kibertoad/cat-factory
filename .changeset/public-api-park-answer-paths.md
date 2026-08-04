---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Public API: answer every remaining park a run can stop on

`/api/v1/runs/:runId/decisions` could answer four parks; a `decide` key could START many more than
that, so a caller could put a run into a state only the app could get it out of. Twenty-four
additive endpoints close the gap: the generic approval gate (approve / request-changes / reject,
plus `resolve-exceeded` for a companion at its rework cap), agent-raised decisions, the
clarity-review and both brainstorm loops, PR deep-review curation, and the two human-verdict gates.
The decision list gained seven kinds alongside them, and the OpenAPI surface version is now `1.4.0`.

Of the parks a pipeline can carry, only `human-review` is now unanswerable, and by construction
rather than omission: its answer is a person approving the pull request on the VCS host. Two park
surfaces the original investigation missed (follow-up triage, interview gates) are recorded in
`docs/initiatives/public-api-additions.md` as unbuilt and are NOT advertised as answerable.

Behaviour change worth reviewing: a park that rides the engine's generic `step.approval` but is
owned by a dedicated surface (a review gate, a fork choice, a human-verdict gate, follow-up triage,
an interview) is reported as its own kind, never as `approval-gate`, because the engine refuses the
generic verbs on those. `StepDecisionController`'s refusal and the public projection now read one
shared classifier so the two cannot disagree.
