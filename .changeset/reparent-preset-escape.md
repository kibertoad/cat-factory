---
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
---

Judge a cross-home task move against the mover, the way a preset selection already is

A task's merge preset decides whether its runs are sandboxed for a role and how their auto-merge is
narrowed, so re-pointing a task is a policy decision and is refused when it would drop a restriction
the editor's own role is under (ADR 0037). That guard was mounted on the two writes that carry
`riskPolicyId`, on the reading that those are the doors. They are not: `resolveRiskPolicy` takes a
workspace AND an id, so the policy in force can be re-decided from either side.

The side nobody guarded is the workspace. A cross-home reparent, dragging a task or a module into a
service homed on another workspace with both mounted on the board, physically migrates the rows to
that workspace, and the destination's preset library is what governs them afterwards. A preset id
belonging to the source is dangling there and falls back to the destination's default, exactly like
a deleted one. So a sandboxed member could drag the task one service over and start it live, having
selected nothing and never meeting the picker's refusal.

`BoardService.reparent` now takes the same required `BlockEditActor` its siblings do, and its
cross-home branch runs the same rule with the workspace varying instead of the id: the policy
resolved at the source home against the one resolved at the destination home, for every task in the
moved subtree, before any row moves. A module carries its tasks, and reading only the dragged block
would see a module, which pins nothing and could never refuse. Same-home moves read no preset at
all, which is the overwhelmingly common drag.

Refusing a role-restricted task's cross-workspace move outright was the simpler option and was
rejected: it would also refuse a move onto a destination that sandboxes the mover just as hard,
which drops nothing. Narrow-only is the whole rule, and a guard that refuses tightenings is not
applying it. The refusal copy is separate from the picker's, because someone who dragged a task
picked no policy and would go looking for a control they never touched; the `details.reason`
vocabulary is unchanged, so the SPA's existing mapping covers both.

Worth a reviewer's attention: `reparent`'s body moved out of `BoardService` into a `reparentWrite.ts`
collaborator behind a thin delegate (the cross-home migration is not a layout write, and the service
was one edit from its size budget), so the diff there reads as a move rather than a rewrite. The
riskiest part is the ORDER in the cross-home branch: the subtree is now listed before the fan-out
capture so the guard can see it, and every write still happens after the refusal.

Also closes a gap the `blockEditActor` coverage spec asserted only in prose: the two `/api/v1`
exemptions justify themselves partly on the public task contracts exposing no preset field, which
matters because the creation route spreads the parsed body straight onto `AddTaskInput`. That is now
a test, on the field read off the internal schemas so it cannot outlive a rename.
