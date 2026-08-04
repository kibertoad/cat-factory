---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Make role-scoped merge policy authorable in the product. `classRulesByRole` and `dryRunRoles` have
been writable over `/workspaces/:ws/risk-policies` since the feature landed, and a dry run has been
requestable on the start endpoint, but neither had an in-app control: an operator configured the
whole capability through the API.

Workspace settings now edits both on each merge preset, directly under the base class rules they
narrow. The editor offers a role only the rules that would actually narrow the class it is on,
because composition is narrow-only and a looser role rule is discarded by the engine; a rule a
later base edit overtook stays visible and clearable, flagged as no longer doing anything. A
cleared rule is stored as an OMISSION and a role whose last rule is cleared drops out of the map,
so `{}` stays the identity the wire contract says it is. A role held to dry runs says on its own
row that the class rules below it can no longer add anything, since the sandbox already outranks
them. The merge-preset preview (the picker a task chooses its policy from) names both layers, so
picking a policy shows what it means for whoever is reading it.

The run controls with a menu to hang it on (the inspector's Run menu and the focus view's picker)
carry the dry-run request. Requesting one is an override of the live default and so is
`advanced`-tier; a sandbox the task's preset FORCES on the caller's role is stated in both tiers and
replaces the control, because there is nothing left to choose. Only an explicit request is sent:
re-sending a forced sandbox would file the run's mode under "the initiator asked for this" and cost
the run the advisory that explains a sandbox nobody chose. A live run's execution panel badges the
mode, since a sandboxed run otherwise looks exactly like one that has not reached its merge yet.

The board's one-tap starts (a task card's Start, and dropping a pipeline onto a task) have no menu
and so offer no request, but they state a forced sandbox before it happens: the card's button, and
a toast on the drop. Being sandboxed is not a setting the user can see anywhere else on those
surfaces, and a silent one is learned from a run that stops at the merge.

`narrowMergeClassRule` moves from `@cat-factory/kernel` to `@cat-factory/contracts` (it is no longer
re-exported from kernel), joined there by `dryRunForcedForRole` and `isDryRun`. All three are rules
the SPA and the engine must agree about: an authoring surface that offered a rule the engine
discards, or that read an absent role as a tier, would be reporting a policy that does not exist.
None of the three is re-exported from its old home, so each has exactly one import path: two paths
onto one rule is the shape that lets a second hand-written copy exist.
