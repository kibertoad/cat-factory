---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/kernel': patch
'@cat-factory/conformance': patch
---

Initiative presets — slice 3: create/planning integration.

- **contracts**: `createInitiativeSchema` gains optional `presetId` + `presetInputs` (validated
  against the resolved descriptor at create and frozen on the entity). New
  `probeInitiativePresetContract` (`POST /workspaces/:ws/initiative-presets/:presetId/probe`,
  body `{ frameId }` → the detected `InitiativePresetInputs`). The workspace snapshot gains
  `initiativePresets: InitiativePresetDescriptor[]`. New pure helpers
  `sanitizeInitiativePresetInputs` (reduce a form to its known, visible fields) and
  `renderInitiativePresetValue` (option-label-aware value rendering), shared by the create flow.
- **orchestration** (`InitiativeService.create`): resolves + validates the preset (an unknown id
  or an invalid form is a create-time `ValidationError`, so nothing is written), and — only when a
  preset resolves — persists `presetId` + the SANITIZED `presetInputs` (known, currently-visible
  fields only, so a hidden field's unvalidated value can never freeze, and a form posted with no
  `presetId` is dropped). For a `skip`-interview preset it seeds the `qa` digest from the filled
  form (one answered exchange per visible, filled field via the new pure `seedPresetInterviewQa`)
  and templates the goal (the human's description wins, else the preset's stated purpose). Absent
  `presetId` ⇒ today's behaviour byte-for-byte.
- **orchestration** (`AgentContextBuilder`): an initiative planning step's context now folds in the
  preset `{ label, promptAddition }` resolved for the RUNNING kind — set ONLY when that kind has
  steering — so the analyst/planner prompts carry the preset's per-kind steering. The generic
  preset registers no steering, so the generic planning prompt is unchanged.
- **kernel**: `AgentRunContext.initiative` gains an optional `preset` sub-object carrying the
  preset `label` + the per-kind `promptAddition` (the frozen form reaches the prompt via `qa`).
- **server**: the shared `WorkspaceController` attaches `initiativePresets`
  (`initiativePresetDescriptors()`) to the snapshot on both the create + read handlers (so both
  facades advertise it), and `InitiativeController` serves the probe endpoint — resolving the
  frame's repo through the existing `resolveRunRepoContext` seam and running the preset's `detect`
  hook, returning `{}` (descriptor defaults) whenever GitHub is unwired / the frame has no linked
  repo / the preset has no probe hook, so it never blocks create. The initiative planning prompts
  render the folded-in preset steering.
- **app**: the SPA hydrates `initiativePresets` from the snapshot and starts planning with the
  initiative's preset descriptor's `planningPipelineId` (the generic/absent preset keeps
  `pl_initiative`) instead of a hardcoded id. A NAMED preset that hasn't hydrated resolves to
  `null` (not the generic pipeline), so "Run planning" stays disabled rather than silently
  launching the interviewer over an already-seeded skip-interview initiative.

Conformance: a shared assertion that both facades advertise the built-in generic preset on the
snapshot (create + read), binding `pl_initiative` and the interviewer.
