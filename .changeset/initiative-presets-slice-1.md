---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
---

Initiative presets — slice 1: preset contracts, kernel registry, and entity extensions.

- **contracts** (`initiative-preset.ts`): the serialisable, SPA-facing preset vocabulary —
  `InitiativePresetField` (the `ProviderConfigField` family plus `checkbox-group`, `path`, and
  single-condition `showWhen` visibility), `InitiativePresetDescriptor` (form + planning-pipeline
  binding + interview/human-review/fragment/policy defaults + a derived `probe` flag), and the pure
  helpers `isSafeRepoDirPath`, `isPresetFieldVisible`, and `validateInitiativePresetInputs`
  (returns `string[]` — empty ⇒ valid). The bounded `InitiativePresetInputs` record + the item
  `spawn` decoration bag (`taskTypeFields`/`fragmentIds`/`agentConfig`/`gates`) live in
  `initiative.ts` (with the entity that persists them) to avoid a valibot import cycle.
- **contracts** (`initiative.ts`): the `Initiative` entity gains optional `presetId` +
  `presetInputs` (frozen at create), and both the tracker item and the planner draft item gain the
  optional `spawn` bag. All ride the existing JSON `doc` blob — no migration, runtime-symmetric.
- **kernel** (`initiative-preset-registry.ts`): the module-global `registerInitiativePreset` seam
  (mirroring the pipeline / gate registries) carrying the descriptor plus the `detect` / `seedPlan`
  code hooks and per-agent-kind `promptAdditions`. Ships the built-in `preset_generic` strangler
  default (always resolvable) and `initiativePresetDescriptors()`, which derives each descriptor's
  wire `probe` flag from the presence of a `detect` hook.

Additive only — an initiative with no `presetId` keeps today's behaviour byte-for-byte.
