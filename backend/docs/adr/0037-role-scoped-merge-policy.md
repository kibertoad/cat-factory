# ADR 0037: Role-scoped merge policy and sandboxed runs

- **Status:** Accepted (implemented)
- **Date:** 2026-08-04
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/orchestration`, `@cat-factory/server`, both runtime facades) + the SPA
  (`@cat-factory/app`)

Supersedes the `role-scoped-merge-policy` initiative tracker, whose committed scope is complete.
Extended by [ADR 0039](./0039-role-scoped-submission-allowlists.md), which closes the gap this ADR
names below: a per-role allowlist of the change classes a preset will land at all, so a tier can be
held short of `source` without being sandboxed on everything.

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

**A sandboxed member cannot un-sandbox themselves, and that took TWO gates, not one.**
`RiskPolicyController` mounts `mountWorkspacePermission('settings.manage')` on `/risk-policies`, so editing
`dryRunRoles` is admin-tier. Without that the setting would be theatre, since the obvious way
around a sandbox is to delete it.

The first cut of this feature stopped there and was wrong to, which is worth recording because the
gap reads as covered: the policy is per TASK, and which preset a task is under is `riskPolicyId` on
the block patch: a `board.write`, member tier, on the same board. So the sandbox held only as long
as nobody re-pointed the task, and the way around it was not to edit the policy but to select
another one: one PATCH, or one click in the inspector's picker (and, one door along, one new task
authored straight onto a permissive preset, since a task that picks nothing is governed by the
workspace default).

Gating the SELECTION behind `settings.manage` was the obvious fix and the wrong one: a preset
library exists to be chosen from per task, and taking that from members would make every preset
admin-only on deployments that authored no role policy at all. `refuseRiskPolicySelection`
(contracts) instead applies this feature's own narrow-only property one level up: **a selection may
not drop a restriction the selector's own role was under.** Two arms when this ADR landed, and both
are role-scoped: losing the sandbox, or losing a class rule the ROLE LAYER narrowed (keyed on
`narrowedByRole`, the same test `thresholds.roleRule` already uses, so a class the two presets
merely differ on in their BASE map is not a refusal). ADR 0039 adds the third, over the submission
allowlist, on the rule stated here: every role-scoped restriction owes this guard an arm.

That last exclusion is the design decision, not an oversight. `classRules` and the ceilings say the
same thing to every tier, so moving a task between them is the per-task policy choice the library
is for; comparing them would refuse ordinary selections on workspaces with no role scoping, and
would still be arbitrary, since it would leave the score ceilings free to move. The consequence
worth having is that the guard is INERT until an operator authors a role policy, exactly as
`{}` / `[]` are the identity everywhere else in this feature.

It binds at the SERVICE (`BoardService.addTask` / `updateBlock` / `reparent`), not in a controller,
because the field is writable at every one of those doors and the escape is whichever one a caller
reaches for. The editor travels as a REQUIRED `BlockEditAuthority` parameter, so a new call site
cannot inherit an exemption from a default, and `blockEditAuthority.coverage.spec.ts` then
classifies each route as attributed or deliberately unattributed with a reason: the typecheck
forces a value, only the spec forces the RIGHT one. That pairing is copied from the run-start attribution above for the same reason: this
feature has now shipped twice with one door enforced and another open.

The spec classifies the sites that NAME an actor rather than the sites that CALL a board write,
and that is the second lesson rather than a detail. Its first cut matched
`boardService.addTask|updateBlock`, which saw four routes and missed the public-API creation path
(a different method name) and the tracker / document spawns (a different package). Each of those
was deciding its own exemption inside a collaborator, where no route stated it. So the exemption
now travels to the layer that can answer it: a service takes the editor and never invents one,
and every site that names a value is classified wherever it lives. What a module does with an
actor is a typecheck's business; which actor it is, is a fact about the request.

#### The third door: a task can change policy without changing its `riskPolicyId`

Two doors write the field, and counting doors was the wrong frame, because the field is not what
resolves. `resolveRiskPolicy` takes a workspace AND an id, so the policy in force can be re-decided
from either side, and only one of them is a `riskPolicyId` write. A CROSS-HOME reparent is the
other: dragging a task (or a module carrying tasks) into a service homed on a different workspace
physically migrates the rows there, and the destination's library is what governs them afterwards.
A preset id belonging to the source workspace is simply dangling at the destination and falls back
to ITS default, exactly like a deleted one. So a sandboxed member could drag the task one service
over and start it live, having selected nothing, with the picker's refusal never consulted.

`reparent` therefore takes the editor too, and its cross-home branch runs the same rule with the
WORKSPACE varying instead of the id: the policy resolved at the source home against the one
resolved at the destination home, for EVERY RUNNABLE block in the moved subtree (a module carries
its contents, and reading only the dragged block would see a module, which pins nothing and could
never refuse). Which levels those are is the declared `BLOCK_LEVEL_RUNS_PIPELINES`, a total
`Record<BlockLevel, boolean>` rather than a `level === 'task'` test at the reader: an `initiative`
block starts its own planning chain and resolves a preset of its own, so a task-only filter handed
the guard an empty list and refused nothing. A level that becomes runnable now fails the typecheck
until it is classified. Same-home moves read no preset at all: same library, same ids, nothing
re-decided.

The copy is separate from the picker's (`MOVE_REFUSAL_MESSAGE`), because someone who dragged a task
between two services picked no policy; told "the merge policy you picked", they would go looking for
a control they never touched. The refusal `reason` vocabulary is unchanged, and the SPA maps it to
its OWN move-worded copy (`board.toast.moveRefused.*`), since the backend does not localize prose
and the picker's strings are written for someone holding a control this person never touched.

The alternative considered and rejected was refusing a role-restricted task's cross-workspace move
outright, without resolving the destination. It is simpler and strictly more restrictive, and that
is the problem: it would refuse the move onto a destination that sandboxes the member just as hard,
which is a move that drops nothing. The narrow-only property is the whole rule, and a guard that
refuses tightenings is not applying it.

#### Every workspace in the decision is a HOME, and so is every role

The first cut of this guard judged against the ACTING workspace on the reading that it is what the
engine resolves too. It is not. `blockRepository.get` is scoped by physical `workspace_id`, so a
run can only ever resolve a block under the workspace that HOMES it, and the tier it pins is the
one the initiator holds on THAT board. A board mounting a service homed elsewhere writes every edit
at the home as well. So the acting board answers for the decision only when it happens to be the
home, and on a shared board it is a third party to it.

Both halves therefore resolve at the home. The LIBRARY: `addTask` judges against the workspace the
row is about to land in and `updateBlock` against the one it lives in, or a task in a mounted
foreign service is judged in a library it will never resolve against, where both sides of the swap
collapse onto the acting workspace's default and the guard cannot refuse anything. The ROLE: the
editor arrives as a `BlockEditAuthority` and the guard asks it per workspace it is deciding in, so
each side of a comparison is read against the tier that side's workspace granted. One pre-resolved
actor is wrong in both directions at once: an admin of the acting board skips the check on two
homes where they are a plain member, and a member of it is refused on roles they hold nowhere the
decision applies.

Two readings fall out of that and are deliberate. A workspace the editor holds no access to
resolves to the unattributed editor, because with no tier there they can admit no run under its
policies, so none of its restrictions is theirs to hold or to drop; read the other way, moving a
task into a service you are not a member of would refuse with a sandbox nobody would have escaped.
And `managesPolicy` stands the rule down from EITHER side, since owning either library means
authoring the outcome outright.

What remains is a presentation wart rather than an escape: the picker on a mounted board offers
the acting board's library, so a member can pick a preset that is dangling at the home and lands on
the home's default. The guard judges the outcome the engine will actually apply, so nothing is
relaxed by it; what is missing is the picker telling the user which library they are choosing from.
That belongs to the shared-service model, not here.

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
decides it for the controls that can carry a choice:

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

#### Every start surface states the sandbox; only some of them can offer the request

The board's task card and its drag-a-pipeline drop are ONE-TAP starts: there is no menu to hang a
toggle on, and adding one would put a mode switch on a control whose whole point is that it is a
single gesture. They therefore carry no request. What they do carry is the half that is not a
choice, because "a policy sandbox is stated in both tiers" is a claim about what the user can SEE
before acting, and a surface that stays silent is exactly the discovery-from-a-stalled-run failure
the badge exists to prevent. The card's Start shows the sandbox on the button it is about to press;
the drop says it in the toast, which is the only moment that surface has.

That reading is `useDryRunPolicy`, split out of `useRunStart` and shared by all four. It is
FUNCTIONS of a block id rather than computeds over one because the surfaces ask in two shapes: a
bound control re-asks when the board selection moves, while the drop handler resolves its target at
the moment of the drop and has no block to bind. One rule, two call shapes, rather than a second
`includes` on the surface that could not use the first.

The corollary on the bound surfaces is that the REQUEST belongs to the block it was made on. The
inspector is mounted once for the session and follows the selection, so it outlives that block:
the request is dropped when the block changes under it, or arming a sandbox on one task would
silently sandbox the next run started on another.

#### The picker refuses what the engine would refuse

`RiskPolicyPicker` disables an option `refuseRiskPolicySelection` would reject, from the same
contracts rule and against the same resolved policy (the named preset, else the workspace default),
so the create form and the inspector need no second reading of what "picked nothing" means. That is
the rule stated at the top of the narrow-only section, applied to the other authoring surface: a
picker offering a row the server answers with a 403 tells someone they made a choice they did not
make. The disabled row keeps its detail pane and gains the reason, because the useful thing to
learn is which policy the task is under and why this one is closed, not that a click did nothing.

## Consequences

- A workspace can hand a task to a non-developer with the sandbox on, and take it off per role and
  per preset, without a second pipeline or a second preset library.
- Every start route now has to declare its attribution, enforced by a coverage spec rather than by
  the typecheck, because pinning nothing stays legitimate for schedules and the public API.
- Two more fields ride the run through admission, persistence, re-drive and settlement. Anything new
  that a run pins at admission owes the same end-to-end conformance assertion, on both runtimes.
- The merge decision now carries the initiator's role and (when it changed the outcome) the narrowed
  rule, so a refusal can name the tier it was narrowed for instead of implying the scores did it.
- A board write can now be refused on POLICY grounds, so `BoardService.addTask`/`updateBlock`/
  `reparent` take a `BlockEditAuthority` and every caller states one. Anything else that becomes
  selectable per task and scoped per role owes the same pair: the rule in contracts (so the picker
  agrees) and the guard at the service (so every door does). It also owes an answer to WHICH
  workspace it decides in: on a shared board the acting one is neither where the row lands nor
  where the role that governs it was granted.
- `resolveMergeClassRule` / `resolveRoleScopedMergeClassRule` moved from kernel to contracts, since
  the SPA now has to make the same judgement. The engine imports them from there.
