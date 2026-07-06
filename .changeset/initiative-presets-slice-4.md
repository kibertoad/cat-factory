---
'@cat-factory/app': minor
'@cat-factory/contracts': patch
---

Initiative presets — slice 4: SPA preset picker + generic descriptor-driven create form.

- **CreateInitiativeModal** becomes a preset-aware create surface: a picker over the registered
  presets (built-in "Custom initiative" + any a deployment registered), defaulting to
  `preset_generic`. The picker is shown only when more than one preset exists, so a stock install
  keeps today's plain title/goal form. On submit the modal sends the selected `presetId` + the
  sanitized `presetInputs`.
- **New `InitiativePresetFields.vue`** — a GENERIC descriptor-driven field renderer (zero per-preset
  frontend code), extending the `ProviderConnectionTab` flat-field pattern with the three shapes a
  preset form needs: `checkbox-group` (multi-select → `string[]`), `path` (repo-relative dir with an
  inline safety error via the shared `isSafeRepoDirPath`), and single-condition `showWhen`
  visibility (via the shared `isPresetFieldVisible`). The model is the typed `InitiativePresetInputs`
  so it round-trips the wire contract unchanged.
- **Probe prefill**: selecting a preset with a detection probe fires
  `POST …/initiative-presets/:id/probe` for the target frame and merges the detected values (known
  fields only) over the descriptor defaults, with a stale-response guard. Best-effort — a failure /
  unwired GitHub falls back to defaults and never blocks create.
- Client-side create validation mirrors the server via the SAME shared
  `validateInitiativePresetInputs`, gating the submit button; the per-field path error renders
  inline. New pure `defaultPresetInputs` util seeds the form's initial typed values from the
  descriptor. Store `create` now forwards `presetId`/`presetInputs`; new `probePreset` store action
  - `probeInitiativePreset` API binding. i18n chrome (`initiative.create.preset` /
    `.pathInvalid`) added across all locales.
- Review follow-ups: the renderer now DROPS emptied fields (blank string / empty multi-select /
  unchecked box) so a cleared field stays absent instead of freezing an empty value on the entity;
  the in-flight probe no longer clobbers a value the user typed while it was loading; and
  `isPresetFieldVisible` (`@cat-factory/contracts`) treats an absent value as `false` for a boolean
  `equals: false` condition, so a `showWhen`-gated field appears at first render for an unchecked box
  (previously only after a toggle) — the same shared function both facades already use.
