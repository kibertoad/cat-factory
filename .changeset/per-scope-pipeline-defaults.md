---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A workspace now states which PIPELINE a run resolves per intake, the way it already states which risk
policy, and a requirements review's findings are split into the two groups that decide who answers
them.

Three changes, one theme: a run nobody is watching should reach a pull request without stopping for a
person who is not coming, and should stop for one exactly where a person is what the situation needs.

**Per-scope default pipelines.** `Pipeline.isDefault` and `Pipeline.isUnattendedDefault`, scoped by
the same `runDefaultScopeFor(intakeOrigin)` the risk-policy default takes, written through the
`organize` body — the one pipeline write a BUILT-IN accepts, which is what makes a shipped rung
promotable at all. Only the UNATTENDED scope is seeded: the in-app scope already resolved an answer
without a flagged row (the interface-mode rung, then catalog order), and seeding one would silently
overrule the adaptive rung an advanced-mode board runs today. An operator-declared row outranks both.

The seeded rung is a new built-in, **`pl_unattended`**. It is the adaptive shape with two deliberate
differences: no `requirements-review`, because the rung a headless caller lands on by default cannot
open a conversation nobody is there to have; and `human-test` plus `human-review` behind ESTIMATE
GATES after the guards, because dropping the conversation removes the platform's chance to ask about
scope, so the oversight is bought back where the evidence is strongest. A caller that wants the
conversation names `pl_complex` and answers it over `/api/v1/runs/:runId/decisions` or on the ticket.

`mp_unattended` narrows the three loop budgets its own posture makes cheap (three reviewer passes
rather than six, two tester-QC iterations, no judge bounce): each is a cap `autonomy: 'unattended'`
settles as "proceed", so spending it buys the run nothing but tokens. `ciMaxAttempts` is deliberately
untouched — exhausting it raises `ci_failed`, a park this policy does not answer, so cutting it would
produce one more stop for a person rather than one fewer. Landing authority is unchanged, and the seed
is NOT version-bumped: existing workspaces hold a CLONE of their own default there (ADR 0053's
migration), and a reseed would restore stock ceilings alongside the narrower budgets.

**The two groups, shown and graded.** The reviewer already classified each finding as answerable from
practice or needing a product decision; that is now the review window's primary grouping rather than a
badge on one edge case, with each section saying what its group is. Every Requirement-Writer
suggestion additionally reports a `confidence`, a different claim from `groundedIn`: that one says
where the answer came from, this one how sure the Writer is of it (a standard can settle a finding only
partly; a general practice can be near-universal). Shown as a band on every suggestion.

**And a run nobody is watching may settle the first group.** Under `autonomy: 'unattended'` the gate
folds the answers in and carries on when every finding was dismissed, resolved, answered by a person,
or auto-answered above the policy's new `minAutoAnswerConfidence` floor (default 0.8). One finding in
the other group, or one graded below the floor, parks the whole review exactly as before, and an
UNGRADED suggestion clears no floor above zero — so a garbled Writer reply parks the run rather than
quietly answering it. The step stamps `autoAnsweredByPolicy`, distinct from the existing
`reviewCapSettledByPolicy`: that one means the loop gave up, this one that it converged on answers
nobody read. ADR 0053 ruled this out on the grounds that inventing a product judgement is off limits;
the narrowing that makes it compatible rather than an exception is that TWO independent judgements
must agree before anything is folded.

**Under `attended`, nothing about the review changes.** A suggestion there is a draft a person is
about to read, so grading it changes nothing about who decides.

Two `/api/v1` additions (`pipelineId` on task creation, `unattendedDefault` on `GET /pipelines`),
OpenAPI `1.50.0`, plus one behaviour change worth reading before upgrading: `POST
/tasks/:taskId/start` with an empty body now STARTS a run for a key that satisfies `decide`, where it
used to answer `400 pipeline_required`. A `write` key sees no change, deliberately — the seeded rung
reaches a human test and a human PR review, so offering it to a caller that cannot answer a park
would trade an actionable "pass a pipelineId" for a 403 about a pipeline it never picked. The refusal
survives wherever no default resolves.
