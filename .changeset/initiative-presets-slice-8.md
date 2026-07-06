---
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
'@cat-factory/prompt-fragments': minor
---

Initiative presets — slice 8 (docs-refresh pilot): register the `preset_docs_refresh` initiative
preset — the FIRST real preset, and the registration pattern the technological-migration preset
(T8) copies. Incorporates inter-phase follow-up #1 (adopt the generic `phaseTemplate` shape
enforcement; do NOT hand-roll phase shaping in `seedPlan`); follow-up #2 (templated pipelines)
stays deferred.

- **agents** (`presets/docs-refresh/preset.ts`): the `preset_docs_refresh` registration — a
  descriptor FORM (doc types, placement mode, docs/diagrams/business-rules dirs with `showWhen`,
  scope hint, human-review opt-in, writing-style fragments), a `detect` probe reusing slice 6's
  `detectDocsLayout`, a declarative `phaseTemplate` (Foundations `required` + one OPTIONAL phase
  per doc type, `allowAdditionalPhases: false`), `promptAdditions` turning the analyst into a
  documentation gap-auditor and shaping the planner's phases + item granularity, and a `seedPlan`
  that stamps per-item spawn DECORATION only (pipeline per doc type, `taskType`/`docKind`/derived
  `targetPath`, writing-style `fragmentIds`, and — when human review is opted in — the per-run
  `spawn.gates` override at each pipeline's review point). Registered as a module side effect on
  import (the `@cat-factory/gates` pattern), so it is available in every deployment with no
  per-facade wiring — the two runtimes cannot drift on it. Plan SHAPE lives in the template + the
  generic ingest normalizer; DECORATION lives in `seedPlan`; the two never overlap.
- **kernel** (`domain/seed.ts`): the preset's interviewer-free planning pipeline
  `pl_initiative_docs` (`[initiative-analyst, initiative-planner, initiative-committer]`, no human
  gates — the form is the interview; per-task review is the opt-in gate-override seam) + its
  exported id `INITIATIVE_DOCS_PIPELINE_ID`, plus `DOCUMENT_QUICK_PIPELINE_ID` for the README /
  diagram spawn pipeline.
- **prompt-fragments**: re-export the `styleFragments` collection so the preset builds its
  writing-style form options from the same source of truth (no duplicated fragment ids/labels).

Backend-only: the SPA renders the new preset from its descriptor with no frontend changes (the
slice-4 generic form renderer + picker), and human review maps to SPAWNED-task gates, so the
planning run stays unattended.
