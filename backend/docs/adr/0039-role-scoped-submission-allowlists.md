# ADR 0039: Role-scoped submission allowlists per change class

- **Status:** Accepted (implemented)
- **Date:** 2026-08-05
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/orchestration`, both runtime facades) + the SPA (`@cat-factory/app`)

Supersedes the `role-scoped-submission-allowlists` initiative tracker, whose committed scope is
complete. Extends [ADR 0037](./0037-role-scoped-merge-policy.md), which named the gap this closes.

## Context

[ADR 0037](./0037-role-scoped-merge-policy.md) gave a workspace two ways to hold a non-engineer's
runs short of landing code, and there is a gap exactly between them.

- **`classRulesByRole` with `never`** routes a class to a human. But the merge route carries no
  permission gate of its own beyond the RBAC viewer write floor (`>= member`), which is the gap ADR
  0037 itself names: a member starts a run, receives the `merge_review` card their own run raised,
  taps merge, and it lands. No second person was involved at any point.
- **`dryRunRoles`** closes that, because a sandboxed run is refused at BOTH exits. But it is
  all-or-nothing: every class that role touches, or none.

So a workspace could not say the thing it most often wants to say: **"a product manager may land
copy and dependency bumps on this service, and may not land source, however good the scores look."**
That forced a choice between sandboxing their whole workflow (they stop being useful) and trusting
them with `source` behind a review card only they will read.

## Decision

A per-role ALLOWLIST of the change classes a preset will land at all
(`RiskPolicy.submissionClassesByRole`), composing with both existing settings and refused at the
same two exits `dry_run` is.

### An allowlist, not a denylist

`submissionClassesByRole` is a strict partial map role → `RuleableChangeClass[]`, in
`@cat-factory/contracts` beside its two siblings. The safety property is the one
`narrowMergeClassRule` has: a class nobody thought about is OUTSIDE the list, so a class added to
the vocabulary in a later release is refused for a scoped role rather than silently landed by it.

### Absent means UNRESTRICTED; empty means NOTHING

Silence is not an empty allowlist, exactly as an absent class is not a `thresholds` rule in
`classRulesByRole` ("absent is not a rule", ADR 0037). Only a role somebody wrote an entry for is
scoped, so `{}` stays the identity the wire contract says it is, and authoring one role's policy
cannot bar every other role. An EMPTY array is a real and different policy: that role lands nothing.

That distinction is why the SPA editor is a switch plus tick boxes rather than tick boxes alone.
With tick boxes alone, "unrestricted" and "lands nothing" render identically, and unticking the last
class would silently invert into the widest policy the setting can express. Turning the switch ON
seeds the classes that are landable TODAY, so the operator subtracts from where the role already
was rather than from a policy they did not ask for.

### `unknown` is INERT, never refused

An unreadable diff must not hold back a run that would otherwise have landed, the same reading
`resolveMergeClassRule` takes: a VCS outage cannot change policy.

This is the OPPOSITE direction from the allowlist rule above, and deliberately so. A class we have
never heard of is a policy gap and refusing it is the conservative answer; a class we could not READ
is an outage, and there the conservative answer is the other one, because the alternative is a
provider blip converting into "this role may not land anything" across a deployment.

### A run with no pinned role matches no entry

Exactly as `dryRunForcedForRole` reads one, and for the reason ADR 0037 gives: a schedule fire, a
public-API start and auth-disabled dev are not a tier, and treating absence as the lowest one would
scope every unattributed run in a deployment the day somebody first scopes a role.

### Refused at BOTH exits, with its own reason

That is what makes this different from a `never` class rule, and it is the whole feature:

- **The auto-merge arm** in `MergeResolver`, above `autoMergeEnabled` and beside `dry_run`. It sits
  there for the same reason `dry_run` does: it is a property of WHO started the run rather than of
  the policy about the work, so no preset setting below it can consent on their behalf.
- **`StepDecisionController.assertSubmissionAllowed`**, beside `assertNotDryRun`, refusing the
  manual merge with a `submission_not_allowed` conflict rather than a borrowed
  `dry_run_not_mergeable`. The two have different remedies, and copy that says "re-run it live"
  would be a lie here: the same role would produce the same refusal.

`class_requires_review` and `role_requires_review` stay distinct from `submission_not_allowed` for
the same reason those two are distinct from each other. Both of those are satisfied by ANY reviewer
merging the PR through this platform; this one refuses the platform merge path outright, and the
remedy is a teammate whose role may land the class, or an admin widening the allowlist.

### `classRulesByRole` and this are ORTHOGONAL, and both apply

A class may be `always` under the role's class rules and still outside its submission allowlist, and
the allowlist wins: it is a bar on landing at all, where the class rule only decides how much review
landing takes. That is also why it is not a fourth `MergeClassRule` value: a rule value would have
to compose through `narrowMergeClassRule`, and "may not land" is not a point on the
`always < thresholds < never` review-strength scale at all.

Nor is it folded into `dryRunRoles` by widening that field. The two answer different questions and
compose: a role in `dryRunRoles` is sandboxed for everything and never consults an allowlist; a role
with an allowlist is sandboxed per class. Merging them would make the narrower setting unable to
express the broader one without listing every class.

### The class is only known at MERGER SETTLEMENT

`MergeTrackRecordService.classify` derives it from the PR's changed files, so this cannot be an
admission-time refusal the way `dryRunRoles` is: the PR is already open by the time the class
exists. That is not a defect. The pull request opening is not the harm; the platform LANDING it is,
which is also what the refusal copy says. It must not claim the change cannot land at all, because
a human with write access on the host can always merge it there, exactly as the `dry_run` copy
already concedes.

The manual-merge guard needs the class too, and takes it from the same `classify` call the resolver
makes (one VCS call, swallowed to `unknown` on failure) through `RunMergePolicy.classifyChangeClass`.
Reading it back off the recorded decision would be one fewer call, but a decision may not exist yet
on every path that reaches the merge route. The guard reads the ALLOWLIST first and pays for the
classification only when a scoped role is on the other side of it, so a deployment that scopes
nobody owes this guard a preset read and nothing else.

### What the decision records

`thresholds.submissionClasses` is recorded whenever the initiator's role is scoped, not only when
the scope refused the PR. This is the opposite convention from `roleRule` (recorded only when it
changed the outcome), and the difference is what each fact explains: an allowlist that PERMITTED
this class is what explains why the same role's next PR on another class will not land, so reporting
it only on the refusal would make the permission read as an absence of policy.

## Consequences

- A workspace can hand a non-engineer a real, useful lane (copy, dependency bumps) on a service
  whose source they may not land, without sandboxing their whole workflow.
- The built-ins ship it EMPTY, so every existing preset behaves byte-for-byte as before, matching
  how `dryRunRoles` and `classRulesByRole` landed.
- A third setting now rides the same role pin, so the ADR 0037 rule stands and gains a case:
  anything a run pins at admission and a settlement path reads owes an end-to-end conformance
  assertion on both runtimes. The one here drives an authenticated `member` start through real HTTP,
  a real engine and a real store, and asserts the allowed class lands, the disallowed one is refused
  at both exits, and an unreadable diff still lands.
- `RiskPolicyService.update` now applies `classRulesByRole` and `dryRunRoles` as well. Both were
  declared on the update contract by ADR 0037 and dropped by the service, so an operator editing the
  role layer of an existing preset got a 200 and no change. Presets authored since that ADR may
  therefore carry less role policy than their author believed; the settings panel shows what is
  actually stored.
