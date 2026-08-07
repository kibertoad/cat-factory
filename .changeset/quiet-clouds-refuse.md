---
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Refuse to auto-merge when no merge policy resolves at all

A run whose task pinned no preset, in a workspace whose preset library had not been seeded (or a
deployment with no preset repository wired), used to fall back to `DEFAULT_RISK_POLICY`, which is
`Balanced` with auto-merge ON. So a deployment that had configured no merge policy still landed
pull requests on a merger model's own scores.

That unresolved case now resolves the new `FALLBACK_RISK_POLICY`, which auto-merges nothing. The
shipped `Balanced` preset is unchanged: still `autoMergeEnabled: true`, still the seeded default,
still no per-class floors. The refusal carries its own merge-decision reason,
`no_policy_configured`, kept apart from `auto_merge_disabled` because the remedies differ in kind:
one names a preset somebody chose and is fixed by editing it, the other says the deployment has
stated no merge policy at all.

A board's built-in preset library is now written when the board is CREATED rather than by the
first `list()`. The engine resolves a task's governing preset without listing anything, so seeding
on a read left a board nobody had opened with no library at all: a run started over the public API
resolved the fallback and refused, while the identical run after one board load merged.
`RiskPolicyService` still repairs an empty library on read, for boards that predate this.

The `merge_review` inbox card is now worded from the decision's own reason rather than from a pair
of booleans beside it, so every rung of the merge ladder describes what actually refused. Only
`exceeded_thresholds` still blames the ceilings; the other reasons no longer report a PR as scored
"outside the task's auto-merge thresholds" when no threshold took part in the decision.
