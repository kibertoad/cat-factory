# Role-scoped merge policy and sandboxed runs

## Goal

Two settings that let a workspace hand the product to people who are not engineers without handing
them the ability to land code:

- **Role-scoped change-class allowlists** (`classRulesByRole`): the per-class auto-merge rules,
  narrowed by the workspace role the run's initiator held. "Auto-merge dependency bumps, but not
  when a member started them."
- **A sandboxed run mode** (`dry_run`): the pipeline runs in full and opens its pull request, but
  nothing merges. Requestable per run, and forced for the roles a preset lists in `dryRunRoles`.

Both are compositions of primitives that already existed: the RBAC role lattice
([ADR 0025](../../backend/docs/adr/0025-workspace-rbac.md)), the per-class rules
([merge-track-record.md](./merge-track-record.md)), and `MergeResolver`'s precedence ladder. No new
table, no new permission, no change to the auth gate.

## Why the role is PINNED, not re-resolved

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

## Narrow-only, and why that is the whole safety property

`narrowMergeClassRule` composes a base rule with a role's rule by taking the STRICTER of the two,
over the ordering `always < thresholds < never`. A role entry can therefore subtract capability and
never add it: `{ source: 'always' }` authored under `viewer`, on a preset whose base holds `source`
at `thresholds`, grants a viewer nothing.

The consequence worth having is that **a role entry is reviewable on its own**. Reading one tells
you what that role at most may do, with no need to hold the base map in your head at the same time —
and no preset edit can turn a role entry into a privilege grant by accident.

### Absent is not a rule

The trap this feature hit in development, caught by a unit test rather than by review: reading a
role's SILENCE on a class through `resolveMergeClassRule` (which substitutes `thresholds` for an
absent class) narrows every `always` in the base map the moment a preset gains its FIRST role entry,
for classes and roles that entry says nothing about.

So the role's entry is read as an optional lookup, and an absent one short-circuits to the base rule.
An EXPLICIT `thresholds` from a role still bites: written down it is a policy ("this tier gets the
score comparison, not the blanket auto-merge"), and only silence is silence.

The same distinction governs an unattributed run. A schedule fire, a public-API start and
auth-disabled dev all pin no role, and each stays on the preset's base rules — the policy that
governed it before role scoping existed. Guessing either way is wrong in a way the other is not:
`admin` hands an unattributed run the widest rules in the preset, and `viewer` sandboxes a
deployment's whole schedule the day it first authors a role entry.

## The precedence ladder

`MergeResolver.resolveMergerStep`, most-significant first:

1. **A dry run merges nothing**, whatever else says. It outranks even `autoMergeEnabled` because it
   is a property of the RUN rather than of the policy: the person who started it was never
   authorised to land this work, so no preset can consent on their behalf.
2. `autoMergeEnabled: false` — the master switch, unchanged.
3. The class rule **as narrowed by the initiator's role**. A role entry can only push this arm
   toward `never`.
4. The credibility + threshold comparison, unchanged.

### Four reasons, kept apart because they need different fixes

`class_requires_review` and `role_requires_review` both mean "the rule says never", and collapsing
them would be the usual mistake: one is fixed by editing the class rule, the other by a teammate on
a higher tier merging the PR as it stands. `thresholds.roleRule` is recorded ONLY when the role
changed the outcome, so its presence always means "this would have gone differently for someone
else" rather than "a role was involved" — a role restating the base rule must not be blamed for a
refusal the base map made anyway.

`dry_run` tops the ladder for the reason it tops the precedence: a sandboxed run's scores were never
consulted, so reporting `exceeded_thresholds` (or `auto_merge_disabled`, on a preset that would
happily have merged it) sends someone to edit a ceiling that had no part in the outcome. The review
card it raises is worded the same way.

## The sandbox has to hold at BOTH exits

`MergeResolver` declining to auto-merge is half a sandbox. The decision leaves a `merge_review`
card, and that card's action calls `mergePr` — so without a second guard, a run that was never
authorised to merge lands its change one tap later, through the surface the mode exists to guard.
`StepDecisionController.mergePr` therefore refuses a dry run's PR with `dry_run_not_mergeable`.

What the mode does NOT claim: the PR is a real PR on the host, and anyone with write access there
can merge it by hand. The guarantee is that the PLATFORM will not do it on a sandboxed run's behalf.

## Why the PR still opens

The deliverable a non-engineer needs to SEE is the diff. Withholding the push would leave them
reading prose about work they cannot inspect, and would need new harness plumbing rather than
composition. What makes the mode a sandbox is that the change cannot reach the default branch, not
that it stays invisible.

## Why `dryRunRoles` lives on the PRESET

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

## Per-item status

| Item                                                                        | Status  | PR  |
| --------------------------------------------------------------------------- | ------- | --- |
| Contracts: `classRulesByRole`, `dryRunRoles`, `RunMode`, decision reasons   | done    | -   |
| Kernel: narrow-only lattice + `resolveRoleScopedMergeClassRule`; seeds      | done    | -   |
| Orchestration: role pin, `resolveRunMode`, `MergeResolver`, `mergePr` guard | done    | -   |
| Server: role threaded from the gate-published access; mode from the body    | done    | -   |
| Cloudflare + Node: two preset columns, migrations, repos                    | done    | -   |
| Conformance: preset round-trip + `unknown` refusal on both runtimes         | done    | -   |
| SPA: merge-decision banner, conflict toast, API client                      | done    | -   |
| SPA: preset AUTHORING controls for both fields                              | pending | -   |
| SPA: a dry-run option on the start-run control                              | pending | -   |

The two pending rows are the authoring half. Both settings are already writable over
`/workspaces/:ws/risk-policies` and a dry run is already requestable on the start endpoint, so the
capability is complete and reachable; what is missing is the in-app way to turn it on without an API
call. Until they land, an operator configures this through the API.
