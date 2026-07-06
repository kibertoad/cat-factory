---
'@cat-factory/orchestration': minor
---

Technological-migration initiative — slice T3: full-interview qa seeding.

A preset's create-time FORM now seeds the planning-interview digest for BOTH interview modes, so a
FULL-interview preset's interviewer starts from the enumerable facts the form already captured
instead of re-asking them. Generic (preset-id-agnostic) behaviour: `preset_generic` and a
preset-less initiative are byte-for-byte unchanged.

- **orchestration**: `InitiativeService.create` now runs `seedPresetInterviewQa` for ANY resolved
  preset (previously only `interview: 'skip'`), folding each filled, visible field into the entity's
  `qa` as one answered exchange. `seedPresetInterviewQa` reads the filled fields, so `preset_generic`
  (empty form) seeds nothing; an absent preset seeds nothing. Goal-templating from the preset's
  stated purpose stays `skip`-only — a full-interview preset's goal is still synthesized by the
  interviewer (blank until it converges when the human gave no description).
- **orchestration**: `InitiativeInterviewService` now adds a generic "the answers above include the
  intake-form responses the stakeholder already provided — treat them as SETTLED, do NOT re-ask what
  the form covers, build on them" steering line to the interviewer prompt when the initiative is
  form-backed (its filled fields were frozen as `presetInputs`). Gated so `preset_generic` / a
  preset-less initiative never sees it, keeping their interviewer prompt unchanged. The interviewer
  digs into the fuzzy, judgment-dependent aspects the form could not capture (downtime tolerance,
  data-migration constraints, compat posture) rather than repeating the form.
