---
'@cat-factory/orchestration': minor
'@cat-factory/conformance': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/app': minor
---

Refuse to auto-merge when no merge policy resolves at all

A run whose task pinned no preset, in a workspace whose preset library has not been seeded (or a
deployment with no preset repository wired), used to fall back to `DEFAULT_RISK_POLICY` — which is
`Balanced`, auto-merge ON. So a deployment that had configured no merge policy still landed pull
requests on a merger model's own scores.

That unresolved case now resolves the new `FALLBACK_RISK_POLICY`, which auto-merges nothing. The
shipped `Balanced` preset is unchanged: still `autoMergeEnabled: true`, still the seeded default,
still no per-class floors.

The refusal carries its own merge-decision reason, `no_policy_configured`, kept apart from
`auto_merge_disabled` because the remedies differ in kind: one names a preset somebody chose and
is fixed by editing it, the other says the deployment has stated no merge policy at all.
