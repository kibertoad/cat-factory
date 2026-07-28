---
'@cat-factory/app': minor
---

Give the Risk policy chooser the same master-detail treatment the pipeline chooser has. Each option
line now shows only the policy name; hovering it reveals what the policy actually does — the risk,
impact and complexity ceilings grouped together under a heading that says they are the thresholds
for merging automatically, without a human review — plus the CI-fix budget. The old one-line label
crammed all four numbers into every row behind abbreviations ("cx ≤60%"), which is now gone.

The "workspace default" row previews the default policy rather than a generic hint, since that is
what a task picking nothing is actually governed by. A policy with auto-merge switched off no
longer quotes ceilings that can never apply, on the option preview or the inspector's summary line.

**Breaking (pre-1.0, no shims):** `inspector.runSettings.defaultPresetThresholds` is removed and
`board.addTask.defaultPreset` no longer takes a `{thresholds}` placeholder; a deployment overriding
either key in its own locale files must drop the placeholder. The `~/utils/riskPolicy` helpers
`riskPolicySummary` / `riskPolicyOptionLabel` are replaced by `riskPolicyCeilings`.
