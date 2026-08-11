# ADR 0054: Per-scope pipeline defaults, and the questions an unattended run may answer

- Status: accepted
- Date: 2026-08-12
- Context layer: `@cat-factory/contracts` + kernel catalog + orchestration (pipelines, requirements
  review) + both runtime facades + the SPA

Extends [ADR 0053](./0053-unattended-run-autonomy.md), which gave a workspace two default RISK
POLICIES and closed by naming the two things a policy row could not fix.

## Context

ADR 0053 let a run nobody is watching answer the parks its own automation raises when it gives up.
It left two gaps, and wrote both of them down.

**The first was the pipeline.** A workspace had ONE default pipeline, resolved positionally
(`seedPipelines()[0]`), and the SPA layered an interface-mode rule on top (`basic` → `pl_build`,
`advanced` → `pl_full`). Neither reading knew whether anyone was watching, so a deployment whose
API-started work should skip the requirements conversation and whose board work should hold it had
nothing to say that with. ADR 0053's own words: "The answer is not to settle the questions but to
keep an attended-heavy step out of the pipeline unwatched runs resolve, which per-scope pipeline
defaults will address separately."

Worse than a wrong default, headlessly there was no default at all. `POST /api/v1/tasks/:taskId/start`
with no `pipelineId`, against a task that pinned none, answered `400 pipeline_required`. And
`POST /api/v1/services/:serviceId/tasks` accepted no `pipelineId` either, so a caller could not even
pin one at creation: an integration filed a task, somebody started it from the board, and it ran
whatever that board defaults to.

**The second was the requirements review.** ADR 0053 covered its ITERATION CAP and deliberately not
its questions: "a review still ASKING questions parks under either posture, because the answers are
a product judgement and inventing them is the one thing an unattended policy may never do." That is
right about product judgements and too strong about the review as a whole, because the reviewer
already sorts its own findings into two groups. `autoAnswerable` has existed since the
auto-recommendation automation shipped: TRUE means a confident answer follows from universal
practice, from the stack the work already uses, or from the context provided; FALSE means a business,
product or domain decision. The Requirement Writer pre-answers the first group so a human is handed a
mostly-filled review. Headlessly that buys nothing: the run parks anyway, and the person who has to
answer is not there.

Two things were missing to make that group settleable. The split was not VISIBLE (the window ordered
findings by how much attention each wanted, and the classification showed only as a badge on one
edge case), and the suggestions were not GRADED — `groundedIn` said where an answer came from, which
is not the same as how sure the Writer is of it.

## Decision

### `Pipeline.isDefault` and `Pipeline.isUnattendedDefault`, resolved by the run's intake

Two nullable flags on the pipelines table, each behind a PARTIAL unique index, written through one
new port method (`PipelineRepository.setDefault`) that demotes the incumbent and promotes the winner
in one transaction. Which scope a run resolves is the SAME `runDefaultScopeFor(intakeOrigin)` the
risk-policy default already used, renamed from `riskPolicyDefaultScopeFor` and moved beside the
intake vocabulary: a second consumer arriving is what proved the question is about the run rather
than about a policy row.

The write door is `organizePipelineSchema` — the body that already carries labels and the archive
flag, and the only pipeline write a BUILT-IN accepts. That is not a convenience: the two rungs a
workspace most wants as defaults are built-ins, and a default is selection metadata, not structure.

**Only the UNATTENDED scope is seeded.** The interactive scope ships with no flagged row, so its
resolution is byte-for-byte what it is today (the interface-mode rung, then catalog order) and a
declared default outranks that when an operator sets one. The asymmetry is the point: the in-app
scope already had a working answer, and seeding a row would silently overrule the adaptive rung an
advanced-mode board resolves. The unattended scope had NO answer, only a refusal.

### `pl_unattended`, a rung whose human doors are reached by measured risk

The seeded unattended default. `pl_full`'s adaptive shape (a `task-estimator` first, the design phase
and the tester pair estimate-gated) with two changes:

- **no `requirements-review`**, because the default rung a headless caller lands on cannot open a
  conversation nobody is there to have; a caller that WANTS it names `pl_complex` and answers over
  `/api/v1/runs/:runId/decisions` or on the ticket (ADR 0047);
- **`human-test` and `human-review`, both estimate-gated**, placed after `conflicts`/`ci`. Dropping
  the conversation removes the platform's chance to ask about SCOPE, so the rung buys the oversight
  back where the evidence is strongest: after the automation has run, and only on a task whose
  estimate says the risk earns it. `human-test` sits behind the higher bar, because a review reads a
  diff that is already open while a manual test needs somebody to drive a running environment. Both
  fail toward `skip` on a missing estimate, the rule `pl_full` already applies: an unestimated task
  must never silently wait forever for a person nobody told about it.

### `mp_unattended` narrows the loop budgets its own posture makes cheap

Three reviewer passes rather than six, two tester-QC iterations rather than three, and no judge
bounce. Every one is a cap `autonomy: 'unattended'` settles as `proceed`, so spending it buys the run
nothing but tokens and wall-clock, and ADR 0053 recorded that a companion re-grading without memory
does not converge anyway.

`ciMaxAttempts` is deliberately UNCHANGED, and it is the entry that shows the rule: exhausting the
CI-fixer budget raises `ci_failed`, a park this policy does not answer, so cutting it would produce
one more stop for a person rather than one fewer. Landing authority — every ceiling, every class
rule, the whole role layer — is untouched, as ADR 0053 requires.

### The two GROUPS are shown, the suggestions are GRADED, and an unattended run may fold in the first

- **Visible.** The review window's primary grouping is now the reviewer's own classification, with
  the judgement group first and each section stating what its group is. Attention ordering (what is
  left to react to) stays, INSIDE each group.
- **Graded.** `RequirementRecommendation.confidence` (0..1, null when unreported) is the Writer's own
  claim about the ANSWER, separate from `groundedIn`'s claim about its SOURCE: a standard can settle a
  finding only partly, and a general practice can be near-universal. Shown as a band on every
  suggestion, since a reader deciding whether to keep a pre-filled answer wants the same number the
  platform used to decide not to ask them.
- **Foldable.** `RiskPolicy.minAutoAnswerConfidence` (default `0.8`, read only under `unattended`) is
  the floor. `reviewSettledForUnattended` then decides: a review settles without a person only when
  every finding was dismissed, resolved, answered by a HUMAN, or auto-answered at or above the floor.
  Anything else parks exactly as before, and the run stamps `step.autoAnsweredByPolicy` when it did
  fold in.

## Rationale

**Why this is not the thing ADR 0053 forbade.** That ADR's rule is that inventing a product
judgement is off limits. Two independent judgements have to agree before anything is folded here: the
REVIEWER sorted the finding into the group it can answer from practice, and the WRITER then graded
the specific answer above a floor an operator set. A finding in the other group is untouchable at any
confidence, and an UNGRADED suggestion clears no floor above zero, so a garbled Writer reply parks
the run rather than quietly answering it. The failure direction is the one that asks a person.

**Why the floor is on the policy and not on the step.** It is a statement about how much oversight
this work takes, which is what a risk policy is, and it has to sit beside `autonomy` for the same
reason `autonomy` is not a pipeline flag: the same pipeline runs from the board and from the API, and
it is the WATCHING that differs. `stepOptions.autoRecommend` stays what it was, a per-step switch for
whether suggestions are produced at all.

**Why an attended run's behaviour is unchanged.** Under `attended`, every auto-answerable finding
still gets a pre-filled suggestion whatever its grade, because there a suggestion is a DRAFT a person
is about to read: grading it changes nothing about who decides, and withholding a low-confidence
draft would take away information. The floor exists for the case where the same suggestion is the
final answer with nobody reading it.

**Why the pipeline default ladder consults the catalog, and only sometimes.** A workspace seeded
before `pl_unattended` existed holds no row for it, so reading only the library would leave every
existing deployment on the old refusal until somebody opened the board and accepted a reseed
advisory — the trap `pipelineAdoption` already closes for a pinned pipeline. But once the row IS in
the library, its flags are the operator's answer INCLUDING the absence of one, so the catalog is
consulted only while the workspace has never adopted the rung it declares. Releasing a default has
to mean something.

**Why `mp_unattended` is NOT version-bumped for its narrower budgets.** This is the one seed where a
bump would be actively unsafe. Existing workspaces did not get the row from the catalog: ADR 0053's
migration materialised it as a CLONE of whatever their own `is_default` row held, precisely so a
workspace that had tightened `Balanced` kept its own ceilings. A reseed restores the CATALOG's values
for every field, so announcing three narrower budgets would hand such a workspace the stock ceilings
alongside them: a widening of landing authority, delivered as an advisory to adopt a tightening. New
workspaces seed the narrower budgets; an existing one adopts them by editing the row.

**Why a dangling `pipelineId` at creation is not refused, unlike a dangling preset pin.** A dangling
`modelPresetId` / `riskPolicyId` falls back to a workspace default and RUNS, which is why
`presetPinGuard` has to catch it at the write: nothing afterwards distinguishes the task that ran on
the model it named. A dangling pipeline pin can start nothing, so it refuses loudly on its own, at
the door that has a picker.

## Consequences

- `POST /api/v1/tasks/:taskId/start` with an empty body now STARTS a run where it used to answer
  `400 pipeline_required`. The refusal survives for a workspace that declares no unattended default,
  so a client branching on it still needs to. OpenAPI `1.50.0`; see `public-api-versions.md` for what
  a caller that used the 400 as a validation probe should read instead.
- `PipelineRepository` gains `setDefault`, mirrored D1 ⇄ Drizzle with a partial unique index on each
  facade and a run-level conformance assertion: one holder per scope, the scopes independent, and a
  release leaving the scope genuinely empty (which, unlike the risk-policy library, is a legal state).
- `riskPolicyDefaultScopeFor` → `runDefaultScopeFor`, and its vocabulary moves from `merge.ts` to
  `run-provenance.ts`. Internal rename, no wire change.
- A FIFTH thing an unattended policy may decide has to answer the test ADR 0053 opened with, plus one
  this ADR adds: is there a second, independent judgement that the platform is allowed to act on, or
  is the automation grading its own homework?
- What the review window shows is now structured by WHO can answer rather than by what is left to do.
  A workspace whose reviewer model predates the classification sees every finding in the judgement
  group, which is the honest reading of an unclassified finding and the same one the engine takes.
