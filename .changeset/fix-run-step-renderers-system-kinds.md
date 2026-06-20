---
'@cat-factory/app': patch
---

Fix zoomed-in board cards (and the inspector / focus view / step overlays) failing
to render a run's pipeline steps.

The default pipelines now include engine "system" steps (`ci`, `merger`,
`blueprints`, `conflicts`, `conflict-resolver`) that live in `SYSTEM_AGENT_META`,
not in `AGENT_BY_KIND`. Several run-step renderers still indexed `AGENT_BY_KIND`
directly, so a step of one of those kinds resolved to `undefined` and threw on
`.icon`/`.color`/`.label` during render. The thrown render killed the whole steps
list: zooming a task in on the board (`TaskPipelineMini`) showed no build steps and
no current-step indicator, and the same crash hit `PipelineProgress`,
`TaskExecution`, `AgentStepDetail`, `AgentChip` and `DecisionModal`.

All of these now resolve display metadata through `agentKindMeta()`, the total
lookup that already covers palette archetypes, system kinds and unknown/custom
kinds, so a kind missing from the archetype map can never blow up a renderer.
`ObservabilityPanel` switches to the same lookup so system steps show their real
labels instead of a generic fallback.
