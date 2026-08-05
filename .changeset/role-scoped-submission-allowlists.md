---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Role-scoped submission allowlists: what a tier may LAND, per change class

A merge preset could already narrow a role's per-class auto-merge rules (`classRulesByRole`) or hold
a role to dry runs entirely (`dryRunRoles`), and there was a gap exactly between them. A `never`
class rule routes a PR to a human, but the human it routes to may be the initiator: the review card
carries a merge button and the RBAC write floor is `member`, so a member's run raises its own card
and lands on the next tap. The sandbox closes that by refusing both exits, but only for every class
at once. So a workspace could not say the thing it most often wants to say: a product manager may
land copy and dependency bumps on this service, and may not land source, however good the scores
look.

A preset now carries `submissionClassesByRole`, a per-role allowlist of the change classes it will
land at all, refused at BOTH exits like a dry run: the auto-merge arm in `MergeResolver` (above
`autoMergeEnabled`, since it is a property of who started the run rather than of the policy about
the work) and the manual `mergePr` path, with its own `submission_not_allowed` conflict rather than
a borrowed `dry_run_not_mergeable`. Re-running live changes nothing here, so copy that suggested it
would be a lie.

Three readings define it. It is an ALLOWLIST, so a class added to the vocabulary later is refused
for a scoped role rather than silently landed by it. Absent means UNRESTRICTED and empty means
NOTHING, so `{}` stays the identity and authoring one role's policy cannot bar every other; that
distinction is why the editor is a switch plus tick boxes rather than tick boxes alone. And
`unknown` is INERT: a diff we could not read is an outage, not evidence about the change, which is
the opposite direction from the first reading and deliberately so.

The built-ins ship it empty, so every existing preset behaves byte-for-byte as before. Internal wire
break: `RiskPolicy.submissionClassesByRole` is required rather than optional-with-a-shim (persisted
rows get `'{}'` from the column default on both runtimes), and `MergeDecision.reason` gains
`submission_not_allowed`.

Also fixes `RiskPolicyService.update` dropping `classRulesByRole` and `dryRunRoles`: both were on
the update contract but never applied, so editing the role layer of an existing preset returned 200
and changed nothing.

The allowlist is role-scoped state, so it takes an arm in `refuseRiskPolicySelection` too
(`relaxes_role_submission_allowlist`), on the rule ADR 0037 set when it closed the same escape for
the sandbox: a task's `riskPolicyId` is a member-tier board write, so without it a role held to
`['docs']` could re-point the task at a preset that allowlists it nothing and land `source` without
editing a policy. The arm is the same subset test the others make, and an ABSENT allowlist on the
far side relaxes every held one, the empty one included. The three arms run in the merge ladder's
own order, so a refused row in the picker names the restriction the run would have been refused on.

Design: `backend/docs/adr/0039-role-scoped-submission-allowlists.md`.
