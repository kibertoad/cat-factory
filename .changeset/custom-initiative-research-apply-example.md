---
'@cat-factory/example-custom-agent': minor
---

Worked example: a `preset_org_research` "research → apply" initiative preset (custom-initiative
slice 6, the acceptance proof).

The `example-custom-agent` package gains a minimal two-phase "research → apply" initiative preset
that exercises every seam the custom-initiative-definitions initiative added: a `checkpoint: true`
research phase (the initiative pauses after the research merges so a human reads the committed
report and resumes on GO / cancels on NO_GO), a custom structured `org-researcher` kind with a
verdict step resolver and an artifact post-op running on a merging pipeline (`pl_org_research`),
spawned-run prompt steering for the built-in `coder` and the custom research kind, and a
`seedPlan`-derived report path stamped on the research item (producer) and baked into the apply
item's description (consumer). It proves a deployment can assemble a proprietary multi-phase
methodology from the public seams alone — no engine or facade change. `pl_org_research` /
`pl_org_apply` pipelines and `registerOrgResearchPreset` are new exports.
