---
'@cat-factory/app': minor
---

Give the Risk policy chooser the same master-detail treatment the pipeline chooser has. Each option
line now shows only the policy name; hovering it reveals what the policy actually does — the risk,
impact and complexity ceilings grouped together under a heading that says they are the thresholds
for merging automatically, without a human review — plus the CI-fix budget. The old one-line label
crammed all four numbers into every row behind abbreviations ("cx ≤60%"), which is now gone.

The "workspace default" row previews the default policy rather than a generic hint, since that is
what a task picking nothing is actually governed by — as does a task whose chosen policy has since
been deleted from the library, which is likewise governed by the default. A policy with auto-merge
switched off no longer quotes ceilings that can never apply, on the option preview or the
inspector's summary line.

The detail pane follows keyboard focus as well as the pointer, so moving the numbers off the option
line doesn't put them out of reach of anyone driving the list from the keyboard.

The risk-policy settings editor now lists its score ceilings — and the fork-decision floors below
them — in the same risk → impact → complexity order as the picker and the inspector, instead of its
own complexity-first one. All three read one exported axis order.

**Breaking (pre-1.0, no shims):** `inspector.runSettings.defaultPresetThresholds` is removed and
`board.addTask.defaultPreset` no longer takes a `{thresholds}` placeholder; a deployment overriding
either key in its own locale files must drop the placeholder. `inspector.runSettings.defaultPreset`
is split into `defaultRiskPolicy` and `defaultModelPreset` — it labelled both subjects from one
string, which no gendered language can do correctly (Polish needs "Domyślna zasada" but "Domyślny
preset"); a deployment overriding it must override the two new keys instead. The
`~/utils/riskPolicy` helpers `riskPolicySummary` / `riskPolicyOptionLabel` are replaced by
`riskPolicyCeilings`.
