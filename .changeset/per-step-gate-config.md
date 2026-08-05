---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/gates': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Per-step gate configuration: approver policies, approval quorums, and gate-declared settings

`Pipeline.gates: boolean[]` said a step paused for "a human" and nothing else. There was nowhere to
say which humans, how many of them, or what a registered gate's own knobs should be for this
particular step — the built-in gates read their attempt budgets and time windows off the
workspace-wide merge preset, and a deployment's own gate had nowhere to put its parameters at all.

A step now carries `stepOptions.gateConfig` (the extensible per-step bag, so no column and no
migration on either runtime), with two halves. The platform owns `approvers` and `minApprovals`: who
may resolve the human gate, and how many DISTINCT people must, both snapshotted onto the approval
when the gate is raised so an edit to the pipeline cannot move the bar under the people already
counted toward it. The GATE owns `fields`, declared on its registration
(`register(kind, factory, { configFields })`) as descriptor fields — one declaration driving the
save-time validation, the run-start re-validation and the authoring form the builder renders, so a
registered gate needs no frontend change to become configurable. The built-ins declare their own
(`maxAttempts`, `watchWindowMinutes`, `graceMinutes`) instead of the engine hard-coding them.

Behaviour changes worth reviewing. The approver policy governs all three resolutions, not just
approve: a gate the wrong person can reject is not a gate. A workspace admin always passes a policy
(they can cancel the run or edit the pipeline anyway, and refusing them would deadlock a gate whose
named approvers have left). A machine key or an auth-disabled caller is refused by any policy — a
shared credential is not one of the people a policy named — which also means a quorum above one
cannot be met on a deployment running with auth off, since counting distinct approvals needs
identities that deployment does not have. All of this is additive: a gate with no config behaves
byte-for-byte as it did.

A quorum votes on ONE artifact, so only the approval that CLEARS the gate may carry a `proposal`
edit. An edit on an earlier approval is refused (`proposal_not_editable_until_quorum`) rather than
silently rewriting the text under the people already counted toward the bar; the SPA withholds the
affordance and says why. Both raise sites for the human gate now go through one `buildStepApproval`
builder, so a gated COMPANION step honours the policy and quorum its step configured.

Public API (`/api/v1`, surface version now `1.9.0`, additive): the `approval-gate` decision projects
`requiredApprovals` and `recordedApprovals`, because a quorum makes `approve` legitimately not
advance the run and without the tally a caller could not tell that from a failed call.

Internal break, per the pre-1.0 rule: `ExecutionService.approveStep` / `requestStepChanges` /
`rejectStep` now require a `GateActor`. Required rather than optional so an entry point that forgets
to supply the acting identity fails to typecheck, instead of silently resolving a gate that names
its approvers as though it named nobody.

Design record: `backend/docs/adr/0038-per-step-gate-config.md` (supersedes the
`extensible-custom-gate-config` initiative tracker, removed).
