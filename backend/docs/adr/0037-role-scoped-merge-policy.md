# ADR 0037: Role-scoped merge policy and sandboxed runs

- **Status:** Accepted (implemented)
- **Date:** 2026-08-04
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/orchestration`, `@cat-factory/server`, both runtime facades) + the SPA
  (`@cat-factory/app`)

Supersedes the `role-scoped-merge-policy` initiative tracker, whose committed scope is complete.

## Context

Two settings that let a workspace hand the product to people who are not engineers without handing
them the ability to land code:

- **Role-scoped change-class allowlists** (`classRulesByRole`): the per-class auto-merge rules,
  narrowed by the workspace role the run's initiator held. "Auto-merge dependency bumps, but not
  when a member started them."
- **A sandboxed run mode** (`dry_run`): the pipeline runs in full and opens its pull request, but
  nothing merges. Requestable per run, and forced for the roles a preset lists in `dryRunRoles`.

Both are compositions of primitives that already existed: the RBAC role lattice
([ADR 0025](./0025-workspace-rbac.md)), the per-class rules
([merge-track-record.md](../../docs/initiatives/merge-track-record.md)), and `MergeResolver`'s
precedence ladder. No new table, no new permission, no change to the auth gate.

### Why not just `autoMergeEnabled: false`?

The first question anyone asks, because "Manual review only" already exists and sounds like it
covers this. It does not, and the two halves of this feature miss it for different reasons.

**`classRulesByRole` expresses something a preset structurally cannot.** A preset is pinned per
TASK (`Block.mergePresetId`), so every one of its settings is uniform across WHO ran the task.
`autoMergeEnabled: false` therefore forces an all-or-nothing choice on a task a product manager and
an engineer both run: turn auto-merge off and the engineers lose it too, or leave it on and the PM's
runs merge themselves. A second preset does not help, because the preset follows the task and both
people run the SAME task. Scoping by the initiator is the only axis on which "auto-merge dependency
bumps, but not when a member started them" is sayable at all.

**`dryRunRoles` closes a narrower gap, and it is worth naming precisely: "manual review only" means
NOT AUTOMATIC, not REVIEWED BY SOMEONE ELSE.** The merge route carries no permission gate of its
own, so the only bar on it is the RBAC viewer write floor, `>= member` (ADR 0025). Under a
manual-review-only preset a member starts a run, receives the `merge_review` card their own run
raised, taps merge, and it lands. No second person was involved at any point. The delta the sandbox
adds is exactly that: the initiator cannot be their own reviewer. Which is also why it had to be
refused at both exits rather than only declining the auto-merge.

## Decision

### The role is PINNED, not re-resolved

`ExecutionInstance.initiatedByRole` records the role at ADMISSION and the merge decision reads that,
rather than resolving the initiator's current role when the merger settles.

Two reasons, and the first is structural. The merge settles on the durable driver's path, which
rebuilds its world from the run row alone: there is no request context there to resolve a role
from, and the engine sits below the auth gate, which is the one place membership resolution is
allowed to happen. This is the same constraint that produced `recordDispatchAttribution`.

The second is that pinning is the honest reading. The authority a run was admitted under is what
the operator granted when they let it start; a role change mid-run retunes the NEXT run rather than
silently re-governing one already in flight.

The run MODE is pinned for the same reason and one more: a preset edited while a run works must not
retroactively un-sandbox a PR a human is already reviewing, nor sandbox one that has been merging
all along.

### Narrow-only, and why that is the whole safety property

`narrowMergeClassRule` composes a base rule with a role's rule by taking the STRICTER of the two,
over the ordering `always < thresholds < never`. A role entry can therefore subtract capability and
never add it: `{ source: 'always' }` authored under `viewer`, on a preset whose base holds `source`
at `thresholds`, grants a viewer nothing.

The consequence worth having is that **a role entry is reviewable on its own**. Reading one tells
you what that role at most may do, with no need to hold the base map in your head at the same time,
and no preset edit can turn a role entry into a privilege grant by accident.

It lives in `@cat-factory/contracts` rather than in kernel because the SPA's preset editor has to
agree with the engine about it: an authoring surface that offered a role a rule the engine will
discard would be telling an operator they had written a policy that does nothing. The editor
therefore offers each class exactly the rules that would narrow it, and keeps (flagged as inert)
one a later base edit overtook.

#### Absent is not a rule

The trap this feature hit in development, caught by a unit test rather than by review: reading a
role's SILENCE on a class through `resolveMergeClassRule` (which substitutes `thresholds` for an
absent class) narrows every `always` in the base map the moment a preset gains its FIRST role entry,
for classes and roles that entry says nothing about.

So the role's entry is read as an optional lookup, and an absent one short-circuits to the base rule.
An EXPLICIT `thresholds` from a role still bites: written down it is a policy ("this tier gets the
score comparison, not the blanket auto-merge"), and only silence is silence. The SPA editor stores a
cleared rule as an OMISSION for the same reason, and drops a role whose last rule was cleared, so
`{}` stays the identity the wire contract says it is.

The same distinction governs an unattributed run. A schedule fire, a public-API start and
auth-disabled dev all pin no role, and each stays on the preset's base rules: the policy that
governed it before role scoping existed. Guessing either way is wrong in a way the other is not:
`admin` hands an unattributed run the widest rules in the preset, and `viewer` sandboxes a
deployment's whole schedule the day it first authors a role entry. `dryRunForcedForRole` (contracts)
is where that reading lives, because the SPA's start control has to state the same thing before a
run exists to read it off.

#### A pin is only pinned if it is PERSISTED, and that is three hops, not one

The gotcha this feature actually hit, and the reason the two fields are worth a section of their own:
`mode` and `initiatedByRole` are settled at START, but every decision that reads them is made on the
DURABLE path, which rebuilds the run from its stored row and nothing else. Three hops sit between
those points, and each drops the fields silently rather than loudly:

- **The detail-JSON writer and reader** (`executionToDetail` / `rowToExecution` in
  `@cat-factory/server`'s `persistence/mappers.ts`) are an explicit ALLOW-LIST, not a spread. A run
  field absent from both is written by `start()`, held in memory for that request, and gone by the
  time anything asks. The first cut of this feature shipped exactly that way: the sandbox never
  engaged and the role narrowing never applied, on both runtimes, with every unit test green.
- **`buildResumedInstance`** (`retry.logic.ts`) mints a FRESH run id over the same work and carries
  fields forward by NAME. Dropping the mode there is a live escape hatch rather than a degraded
  feature, because `restartFromStep` has no `failed` precondition: start a dry run, restart from
  step 0, get a live run over the same work through the ordinary affordance.

**Why no test caught it**: a `MergeResolver` unit test hands the resolver an instance it built in
memory, so it passes no matter which hop drops the field. The guard is the run-level conformance
case in `merge-track-record-suite.ts`, which drives a `mode: 'dry_run'` start through real HTTP, a
real engine and a real store on both runtimes, and asserts BOTH exits refuse. Anything new that a
run pins at admission and a settlement path reads owes the same end-to-end assertion.

**The two decodes are deliberately asymmetric.** An unrecognised `initiatedByRole` is dropped onto
the base rules: the role layer is subtractive, so losing it returns the run to a policy an operator
authored, never past it. An unrecognised `mode` FAILS CLOSED to `dry_run`, because a value that is
present-but-unreadable means a mode was settled and we cannot tell which, and reading it as `live`
would hand the run merge authority it may never have had. Absent still means `live` in both cases:
that is what every run predating the fields actually was. A run wrongly held back is one human tap
from merging; a run wrongly merged is not recoverable.

#### Starting a run is a decision about ATTRIBUTION, and it has two answers

A start route either admits the run under the caller's tier or deliberately admits it under none.
Both wrong answers are silent, because a run with no pinned role is indistinguishable from a
schedule fire: it stays on the base rules and merges, reporting nothing. This feature shipped wired
into `ExecutionController` alone, so the bug-hunt adopt route (a member-tier start, in another
module) minted runs that escaped both halves of the policy.

So the role is read through the ONE `runInitiatorRole(c)` accessor (never a hand-rolled read of the
gate's context, which is a second place to get the dev-open `null` wrong), and
`server/test/runAdmission.coverage.spec.ts` CLASSIFIES every start route as attributed or
deliberately-unattributed-with-a-reason. A new start route fails there until someone writes down
which it is. It cannot be a typecheck: `initiatedByRole` is optional and must stay optional, because
schedules, loops and the public API legitimately pin nothing. A headless `/api/v1` start
authenticates as an API KEY, which holds scopes rather than a tier, so there is no role to pin.

### The precedence ladder

`MergeResolver.resolveMergerStep`, most-significant first:

1. **A dry run merges nothing**, whatever else says. It outranks even `autoMergeEnabled` because it
   is a property of the RUN rather than of the policy: the person who started it was never
   authorised to land this work, so no preset can consent on their behalf.
2. `autoMergeEnabled: false`, the master switch, unchanged.
3. The class rule **as narrowed by the initiator's role**. A role entry can only push this arm
   toward `never`.
4. The credibility + threshold comparison, unchanged.

#### Four reasons, kept apart because they need different fixes

`class_requires_review` and `role_requires_review` both mean "the rule says never", and collapsing
them would be the usual mistake: one is fixed by editing the class rule, the other by a teammate on
a higher tier merging the PR as it stands. `thresholds.roleRule` is recorded ONLY when the role
changed the outcome, so its presence always means "this would have gone differently for someone
else" rather than "a role was involved": a role restating the base rule must not be blamed for a
refusal the base map made anyway.

`dry_run` tops the ladder for the reason it tops the precedence: a sandboxed run's scores were never
consulted, so reporting `exceeded_thresholds` (or `auto_merge_disabled`, on a preset that would
happily have merged it) sends someone to edit a ceiling that had no part in the outcome. The review
card it raises is worded the same way.

### The sandbox has to hold at BOTH exits

`MergeResolver` declining to auto-merge is half a sandbox. The decision leaves a `merge_review`
card, and that card's action calls `mergePr`, so without a second guard, a run that was never
authorised to merge lands its change one tap later, through the surface the mode exists to guard.
`StepDecisionController.mergePr` therefore refuses a dry run's PR with `dry_run_not_mergeable`.

#### What the sandbox does and does not guarantee

**It is not a boundary against a direct merge on the host.** The PR is a real PR, and anyone with
write access on GitHub can merge it by hand. Nothing here can prevent that, and the mode does not
claim to.

**What it does close is a PRIVILEGE-ESCALATION path through the platform**, which is the part that
makes it more than a speed bump for the people it is aimed at. The engine merges with the
INITIATOR'S OWN token only when they stored a PAT and the workspace allows the preference;
otherwise it falls back to the DEPLOYMENT credential (`runInitiatorToken.ts`). So a non-developer
with no repo write and no stored PAT cannot merge on GitHub, but tapping the review card merges as
the App installation, which can. Refusing `mergePr` removes a capability that person did not
otherwise have.

**Its value is therefore conditional on a fact this platform does not check**: whether the
sandboxed person has write access to the repo. Against someone who does, the mode is advisory, a
declaration of intent rather than enforcement. Operators should read it that way, and a deployment
that needs the stronger guarantee wants branch protection (the security model's checklist item 1),
not this setting.

**It is not separation of duties in general.** It scopes the tiers a preset names, and nothing
more. An admin can still be the sole human on their own run's PR under any preset.

**A sandboxed member cannot un-sandbox themselves.** `RiskPolicyController` mounts
`requireWorkspacePermission('settings.manage')` on `*`, so editing `dryRunRoles` is admin-tier.
Without that the setting would be theatre, since the obvious way around a sandbox is to delete it.

### Why the PR still opens

The deliverable a non-developer initiator needs to SEE is the diff. Withholding the push would
leave them reading prose about work they cannot inspect, and would need new harness plumbing
rather than composition. What makes the mode a sandbox is that the change cannot reach the
default branch, not that it stays invisible.

### Why `dryRunRoles` lives on the PRESET

It is a policy about a body of work, not a capability of a person: the same product manager may be
trusted to land copy changes on one service and nothing at all on another, and the preset is already
what a task selects. Putting it on the role catalog would make it deployment-wide and force a
custom-role model to express what one field does today.

The composition with an explicit request is deliberately ONE-WAY. A sandboxed role asking for a live
run gets a sandbox, because a setting a run can decline is advisory, and this one exists precisely
for the case where the person starting the run is not the person deciding what may land. The mirror
is just as deliberate: `resolveRunMode` reports the disposition as `role_policy` rather than folding
it into `requested`, and the run carries a note saying so. Someone who asked for a live run and got a
sandbox has to be able to tell policy from a mis-click.

### In the SPA: the request is an override, the policy sandbox is not

The two halves reach the interface tiers differently, and `useRunStart` is the one place that
decides it for every start control:

- **Requesting a dry run** is an override of the default a live start would have used, unset until
  asked for and never persisted, so it is `advanced`-tier: hiding it leaves exactly the run a
  basic-tier user would otherwise have started.
- **A policy sandbox** is stated in BOTH tiers and REPLACES the request control rather than sitting
  beside it, since there is nothing left to choose. A toggle over a decision already made is the
  concealed-setting failure in reverse.

Only an EXPLICIT request travels on the start call. Re-sending a forced sandbox as a request would
file the run's mode under "the initiator asked for this" and cost the run the advisory that explains
a sandbox nobody chose. And because a sandboxed run looks exactly like one that has not reached its
merge yet, the run says what it is from the start (the run-mode badge on the execution panel), not
only when the merger settles.

## Consequences

- A workspace can hand a task to a non-developer with the sandbox on, and take it off per role and
  per preset, without a second pipeline or a second preset library.
- Every start route now has to declare its attribution, enforced by a coverage spec rather than by
  the typecheck, because pinning nothing stays legitimate for schedules and the public API.
- Two more fields ride the run through admission, persistence, re-drive and settlement. Anything new
  that a run pins at admission owes the same end-to-end conformance assertion, on both runtimes.
- The merge decision now carries the initiator's role and (when it changed the outcome) the narrowed
  rule, so a refusal can name the tier it was narrowed for instead of implying the scores did it.
