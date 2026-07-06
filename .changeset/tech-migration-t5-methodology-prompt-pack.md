---
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
---

Technological-migration initiative — slice T5: the methodology prompt pack + the interviewer
promptAddition seam.

Adds `backend/packages/agents/src/presets/tech-migration/`, the code-side methodology steering the
upcoming `preset_tech_migration` registration (T8) will spread onto its `promptAdditions`. Kept OFF
the wire descriptor per the parent's off-the-wire rule (the descriptor's `phaseTemplate` carries
only the short phase ids/titles/goals; the deep methodology lives here):

- **`phases.ts`** — `MIGRATION_PHASE_IDS` (+ `MIGRATION_PHASE_ID_ORDER`), the single canonical
  phase-id contract shared by the phase template, this prompt pack, the plan post-processor
  (`seedMigrationPlan`, T7) and the migration E2E (T10), so no consumer retypes a phase id (a typo
  would silently break the ingest normalizer's verbatim id match).
- **`prompt-additions.ts`** — `MIGRATION_PROMPT_ADDITIONS` (keyed by the kernel initiative kind
  constants) with the interviewer / analyst / planner steering: the interviewer probes the fuzzy,
  form-uncapturable migration facts (downtime tolerance, data-migration constraints, compat posture)
  and never re-asks the seeded form; the analyst produces the direct + TRANSITIVE blast-zone
  inventory with per-touchpoint existing-test coverage; the planner authors per-phase item briefs
  (single-writer artifacts, the human-gated confidence-case item, coverage-before-delivery),
  referencing the canonical phase ids verbatim.

Completes the interviewer half of the preset `promptAdditions` seam in
`InitiativeInterviewService`: the analyst/planner already fold their steering via `AgentContextBuilder`
→ `initiativeContextLines`, but the interviewer is an inline service that builds its own prompt, so it
now folds `promptAdditions['initiative-interviewer']` under the same `## Initiative preset: <label>`
heading. Generic and preset-less initiatives register none, so their interview stays byte-for-byte
unchanged — the migration preset is simply the first FULL-interview preset to steer its interviewer.
Both changes are dormant data + a generic seam until T8 registers the preset; the loop never branches
on a preset id.
