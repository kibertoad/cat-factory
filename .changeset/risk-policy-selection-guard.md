---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Close the merge-preset selection escape hatch in the role-scoped merge policy

ADR 0037 sandboxes a role's runs (`dryRunRoles`) and narrows what they may auto-merge
(`classRulesByRole`), reading both off the merge preset the TASK selects, and concluded that a
sandboxed member cannot un-sandbox themselves because editing a preset is admin-tier. That covered
only one door. Which preset a task is under is `riskPolicyId` on the block patch: a plain
`board.write`, member tier, on the same board. Re-pointing the task at a preset that sandboxes
nobody was one PATCH or one click in the inspector's picker, and authoring a new task straight onto
one was the same escape a door along, since a task that picks nothing is governed by the workspace
default. Both built-in presets ship with empty `dryRunRoles`, so an open preset is always to hand.

Gating preset selection behind `settings.manage` was the obvious fix and the wrong one: the preset
library exists to be chosen from per task, and taking that from members would make every preset
admin-only on deployments that authored no role policy at all. So the fix applies the feature's own
narrow-only property one level up: a selection may not drop a restriction the SELECTOR's own role
was under, either the sandbox or a class rule the ROLE LAYER narrowed. It deliberately does not
compare the presets' base policy (ceilings, `autoMergeEnabled`, `classRules`), which says the same
thing to every tier, so on a workspace whose presets treat every initiator alike, which is every
built-in, the guard cannot refuse anything and selection behaves exactly as before.

Worth reviewing: the refusal binds at `BoardService`, not in a controller, because `riskPolicyId` is
writable at creation AND by patch and the escape is whichever door a caller reaches for. The rule
itself lives in `@cat-factory/contracts` so the SPA's picker disables an option the engine would
refuse rather than offering it and returning a 403. `resolveMergeClassRule` /
`resolveRoleScopedMergeClassRule` moved from kernel to contracts for that reason; the engine imports
them from there now.

Internal break, per the pre-1.0 rule: `BoardService.addTask` / `updateBlock` and the `BoardWritePort`
they satisfy now require the acting `BlockEditActor`. Required rather than optional so a new call
site cannot inherit an exemption from a default; `blockEditActor.coverage.spec.ts` then classifies
each route as attributed or deliberately unattributed with a reason, since the typecheck can force a
value but not the right one.
