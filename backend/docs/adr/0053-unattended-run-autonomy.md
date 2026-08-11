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
workspace from landing, which is a regression dressed as a new feature. So both migrations
materialise `mp_unattended` in every workspace that already has a library and then name the
unattended default "unless configured differently": a workspace still sitting on the shipped
`mp_balanced` gets the new policy, and one whose operator had already moved the default onto a policy
of their own keeps THAT for unattended runs too. Landing authority never moves underneath somebody
who has already stated theirs; all they gain is a run that stops waiting on a person who is not
there, and they opt into more by re-pointing the flag.

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
- The three parks this covers are the ones the engine raises when its own automation gives up. A
  FOURTH such park added later has to decide whether it belongs to that set, and the honest test is
  the one this ADR opens with: does a person's answer here settle a judgement, or does it only
  confirm that the automation should stop trying?
