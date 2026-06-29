---
'@cat-factory/app': patch
---

Localize the pipeline, palette, and gate surfaces (phase 7 of the app i18n migration).

All user-facing copy in the `pipeline/**`, `palettes/**`, and `gates/**` components now
resolves through `@nuxtjs/i18n` instead of hard-coded strings, under the new `pipeline.*`,
`palette.*`, and `gates.*` namespaces:

- The pipeline builder (`PipelineBuilder`): the slideover, agent palette + draft chain with
  the per-step companion/approval/consensus/follow-up toggle tooltips, estimate-gating
  thresholds, the consensus strategy picker + participants, the saved-pipeline library
  (archive/clone/edit, label filters), the add-agent modal, and every toast.
- The pipeline-progress timeline (`PipelineProgress`): instance/step status labels,
  background review stages, subtask + follow-up readouts, restart controls, and the
  approval / decision prompts.
- The pipeline-health advisory (`PipelineHealthModal`): the invalid / outdated sections and
  reseed / delete actions.
- The agent palette (`AgentPalette`) and the shared iteration-cap prompt
  (`IterationCapPrompt`, its three default choice labels).
- The gate result window (`GateResultView`): the CI / conflicts / human-review variants —
  subtitles, the rolled-up display status, failing-check list, approval progress, the
  request-a-fix box, the attempt timeline, and the sidebar state/budget/footer.

New keys ship in all five bundled locales (en/es/fr/pl/uk). Count readouts use plurals with
the correct forms (3-form one/few/many for pl/uk); the local status/state/strategy/outcome
enum lookups resolve via exhaustive `Record` maps of literal `t(...)` keys so the
typed-message-key drift guard stays live; the "agents complete" count uses an `<i18n-t>`
slot for its bold figure; and timestamps go through the vue-i18n date formatter.
`pipeline/AgentKindIcon.vue` carries no own strings (it resolves everything from the shared
catalog, deferred to phase X), so it needs no migration.
