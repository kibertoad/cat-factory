# ADR 0053: Unattended run autonomy, and a second default risk policy

- Status: accepted
- Date: 2026-08-11
- Context layer: orchestration (risk policy) + the runtime facades' preset stores

## Context

The headless acceptance suite (`backend/internal/acceptance`) drives a real deployment entirely
over `/api/v1`. It stopped on this:

> The run parked on a 'approval-gate' decision raised by step 'architect-companion', which this
> suite deliberately does not answer.

That park is the companion REWORK CAP. `pl_build` runs an `architect` and its inline
`architect-companion`; the companion grades the design and loops the architect back below its
threshold, and when the automatic budget (`maxAttempts`) is spent with the rating still short, the
step parks and offers a person three choices: one more round, proceed on what the producer has, or
stop and reset the task.

Every one of those choices needs a human. The suite is right to refuse them, and so is any other
headless caller. But nothing was watching, so the run waited forever, and the same is true of every
run this platform starts without a person in the app: a `POST /api/v1/.../runs`, a tracker-dispatched
ticket, a schedule fire.

The cap is not the only such park. The engine raises three of them, all with the same shape:

- a companion at its rework cap (above),
- an iterative review at its reviewer-pass cap (`exceeded`),
- the Coder's follow-up companion holding the run while any item is undecided.

None of these is a checkpoint anybody asked for. Each is the automation reporting that it gave up,
and each already offers a person a documented "proceed anyway".

They are structurally different from the parks a PIPELINE asks for: a step marked `requiresApproval`,
a `human-test` step, visual confirmation, the human/PR review gate, a brainstorm or interview, the
implementation-fork choice, the pre-dispatch input gate. Somebody put those in the pipeline, or a
policy asked for them. Their whole product IS a human decision.

Two things were missing, and only one of them is the behaviour.

**The posture had nowhere to live.** Whether a run may answer its own caps is not a property of a
step or a pipeline: it is a statement about how much oversight this work takes, which is exactly what
a risk policy already is (auto-merge ceilings, CI-fixer budget, reviewer iterations, judge scores,
per-role landing authority).

**A workspace had only ONE default policy.** `isDefault` resolved for every task that pinned none,
whoever started it and however. A deployment that wanted its API-started work to finish on its own
and its board work to stop for a person had no way to say so short of pinning a policy on every task
it filed.

## Decision

**`RiskPolicy.autonomy`**, a closed two-member vocabulary in `@cat-factory/contracts`:

- `attended` (every policy before this existed, and every built-in but one): the caps above park and
  wait for a person.
- `unattended`: the platform takes the "proceed" answer to each of those caps, ON THE RECORD, and
  never touches a park the pipeline asked for.

"On the record" is load-bearing and is why this is not simply a suppressed park. A companion cap
settled by policy stamps `step.companion.capSettledByPolicy`; a follow-up dismissed by policy stamps
`item.dismissedByPolicy`. The last companion verdict already says the producer was below the bar, and
without the stamp a run that advanced anyway is indistinguishable from one whose companion quietly
stopped grading. Whoever reviews the resulting pull request needs to be able to tell those apart.

**A second workspace default, `RiskPolicy.isUnattendedDefault`**, resolved for a task that pinned no
policy when NOTHING is watching the run. Which of the two scopes a run takes is
`riskPolicyDefaultScopeFor(intakeOrigin)`, a `Record` over the intake vocabulary:

| intake       | scope         |
| ------------ | ------------- |
| `ui`         | `interactive` |
| `public-api` | `unattended`  |
| `tracker`    | `unattended`  |
| `schedule`   | `unattended`  |

Its own `Record` rather than a reuse of `isHeadlessIntake`, which the two disagree with on
`schedule`. That predicate answers "is there a stable place to hold a CONVERSATION" (a cadence fire
works the schedule's reused block, whose linked ticket is re-pointed on the next fire), which has
nothing to do with whether anyone is watching it run. Deriving this scope from that one would have
left every scheduled run parked on a cap until somebody happened to open the board.

**A third built-in policy, `mp_unattended` ("Unattended delivery")**, seeded into every workspace and
flagged `isUnattendedDefault`. It is `Balanced` with ONE field changed. That restraint is the
decision, not an omission: a seed may decide that an unwatched run should not wait forever on an
automation budget, because waiting was never an answer anybody wanted there. It may NOT decide that
an unwatched run gets to land a change an operator's own thresholds would have held. A deployment
that wants that widens the ceilings itself, having seen its own track record.

**Resolution takes the RUN, not just the block.** `RunMergePolicy.resolve(workspaceId, block, run)`
and the `resolveRiskPolicy` callback every gate window closes over gained a required third argument
(`RunPolicyScope`, structurally `Pick<ExecutionInstance, 'intakeOrigin'>`). Required rather than
defaulted, so a call site that has not threaded the run through fails to compile: the alternative
reads as correct and silently hands an unwatched run the in-app policy, which is the exact behaviour
the parameter exists to fix.

## Rationale

**Why the policy row and not a pipeline flag, a workspace setting, or the intake alone.**

A pipeline flag would put the answer in the wrong place: the same pipeline is run both from the board
and from the API, and it is the WATCHING that differs, not the work. A workspace setting would make
the posture un-pinnable per task, where a risk policy is already the thing a task pins to say how
much oversight it takes. Keying purely off `intakeOrigin` (no policy field at all) was the smallest
change and was rejected because it takes the decision away from the operator entirely: a deployment
that genuinely wants its API-started work to stop for a person would have had no way to say so.

**Why the migration backfills rather than letting existing boards adopt it through the reseed
advisory.** A scope with no default resolves `FALLBACK_RISK_POLICY`, which auto-merges nothing.
Shipping the column empty would have silently stopped every API-started task in every existing
workspace from landing, which is a regression dressed as a new feature.

**And why it CLONES that workspace's own default rather than writing the catalog's values.** A
built-in is editable in place, so a row's id says nothing about whether its ceilings are still the
ones we shipped: a workspace that tightened its `Balanced` down to `maxRisk: 0.1` with auto-merge off
keeps `id = 'mp_balanced'`. Seeding stock values beside it — which the first cut of this migration
did, gated on exactly that id — would have handed every API-started run in that workspace a wider
licence to land than its operator's own default grants. So `mp_unattended` is materialised as a copy
of whatever the workspace's `is_default` row holds, with `autonomy` as the only field changed: every
ceiling, budget and per-role restriction is inherited, `dry_run_roles` and
`submission_classes_by_role` above all, being the role-scoped landing authority itself. Landing
authority never moves underneath somebody who has already stated theirs; all they gain is a run that
stops waiting on a person who is not there, and they widen it themselves by editing the row.

**Why `Balanced` and `Manual review only` do NOT get a version bump.** A bump is an advisory that a
workspace should reseed, and accepting one restores a row's canonical name, ceilings, auto-merge
posture and per-role rules, wiping whatever an operator edited into a built-in they are explicitly
allowed to edit. That price is worth paying when a seed's CONTENT moved. Here it did not: both new
fields land on those rows as the migration's own column defaults, so a stored v6 row and a freshly
seeded one are byte-for-byte identical, and every existing deployment would have been told to adopt
a zero-delta change.

**Why `proceed` and not the other two cap choices.** `extra-round` spends model calls on a loop that
has already demonstrated it does not converge; `stop-reset` throws away the run. Both are defensible
for a person weighing this particular task, and neither is defensible as a standing rule.

**Why follow-ups are DISMISSED rather than queued.** A follow-up is work the Coder noticed and
deliberately did not do. Queueing it sends the Coder back to widen a change past what the task asked
for, unreviewed, on a run with no supervision. Dismissing keeps the run inside its brief; the items
stay on the step with their text intact, so nothing the Coder noticed is lost.

**Why the board's policy-selection guard now judges BOTH scopes.** It refuses a task move that would
relax what the mover's own role is held to, and a task that pins no policy resolves a different row
per scope. Judging only the interactive one would admit a move that is safe for the board's in-app
runs and hands the same task's API-started runs a wider landing authority. The library is already
read whole, so the second scope costs no query.

**Why that guard also gained an OVERSIGHT arm.** Every workspace now seeds a policy whose role layer
is empty — `mp_unattended` carries no `dryRunRoles`, no allowlist and no per-role class rule, exactly
like `mp_balanced` — so all three of the guard's existing arms pass it, and pinning a task to it was
a member-tier board write away. What it changes is not landing authority but whether a run stops for
a person at all, which is the same kind of capability the guard exists to compare. `relaxes_run_oversight`
is tested ahead of the merge-ladder arms, because the parks it drops are raised while the run is
still working, before there is a pull request to weigh.

## Consequences

- An unattended run that would previously have parked on one of the three caps now finishes, and says
  on the step why it got past the bar. The headless acceptance suite's specs run end to end.
- `attended` is byte-for-byte the previous behaviour, and it is what every custom policy, every
  policy created through the API or the SPA without saying otherwise, and `FALLBACK_RISK_POLICY` all
  get. An unrecognised stored value reads as `attended` too: not knowing what a policy says is not a
  licence to proceed unattended.
- Two `/api/v1` additions (`isUnattendedDefault`, `autonomy` on `GET /api/v1/risk-policies`), OpenAPI
  `1.49.0`. `isDefault` keeps its exact former meaning; see `public-api-versions.md`.
- `RiskPolicyRepository.getDefault` takes the scope, and `upsert` enforces the single-default
  invariant PER scope (the two flags are independent, so one row may hold both). Neither scope's
  default can be deleted.
- The parks this covers are the ones the engine raises when its own automation gives up. The JUDGE's
  rework cap is the fourth, decided by that test and answered the same way; its two OTHER parks are
  not (`onFail: 'park'` is a registration asking for a person, and a verdict with no producing step
  to bounce to never got to try), which is why `disposeJudgeVerdict` returns a machine-readable
  `JudgeParkReason` rather than leaving the engine to tell them apart by their prose.
- The iterative review's cap is covered too, and stays RARE by construction: a review still ASKING
  questions parks under either posture, because the answers are a product judgement and inventing
  them is the one thing an unattended policy may never do. An unattended run therefore meets that
  park first. The answer is not to settle the questions but to keep an attended-heavy step out of
  the pipeline unwatched runs resolve, which per-scope pipeline defaults will address separately.
- A FIFTH such park added later has to decide whether it belongs to that set, and the honest test is
  the one this ADR opens with: does a person's answer here settle a judgement, or does it only
  confirm that the automation should stop trying?
- **A budget only buys convergence if the loop remembers.** `step.companion.verdicts` accumulated a
  verdict per grading cycle and no prompt ever read it, so a companion re-graded a revised document
  knowing nothing of what it had asked for last round: independent draws, a fresh subset of problems
  each pass, and a rating that wandered (72% → 77% → 72% → 78% on a real run) while the work
  improved. The JUDGE bucket had carried its previous verdict from the start; the companion bucket
  now does too, both sides of the loop, through one `AgentRunContext.priorReview` slice and one fold
  in `userPromptFor`. The anchored 0..1 scale is shared with the judge for the same reason a
  threshold has to mean one thing: an operator sets a single number per policy.
