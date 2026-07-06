---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/kernel': patch
---

Technological-migration initiative — slice T1: preset phase templates (contract + planner prompt fold).

A generic, declarative capability that lets an initiative preset shape its plan's phase
structure; the migration preset (a later slice) is its first consumer, and `preset_generic`
declares no template and stays byte-for-byte free-form.

- **contracts**: `InitiativePresetDescriptor` gains an optional `phaseTemplate: { phases:
[{ id, title, goal, required? }], allowAdditionalPhases? }`. `id`/`title`/`goal` reuse the exact
  clamps of `initiativePhaseSchema` (so a template phase matches a planned phase by id); phase ids
  must be unique and the array non-empty. Pure serialisable wire data (like `policyDefaults`), so
  it rides the workspace snapshot and a future SPA create-time preview needs zero per-preset work.
- **kernel**: `AgentRunContext.initiative.preset` now carries an optional `phaseTemplate` and its
  `promptAddition` is optional — a preset may contribute a template, steering, or both.
- **orchestration** (`AgentContextBuilder`): the preset-context resolver surfaces the descriptor's
  `phaseTemplate` and returns the preset context when EITHER a per-kind `promptAddition` OR a
  `phaseTemplate` is present (neither ⇒ absent, so the generic planning prompt is unchanged).
- **server** (planner prompt fold): when the resolved preset declares a template, the initiative
  **planner** prompt renders a generic "Required plan shape" section — phase ids VERBATIM, titles,
  goals, order, and whether extra phases are allowed. Generic code that never branches on a preset
  id; no template ⇒ the free-form planner prompt is byte-for-byte today's, and the analyst prompt
  (a prose step) never renders the plan shape.

Ingest normalization/enforcement of the template shape is the following slice (T2); this slice
lands the contract + the prompt fold only.
