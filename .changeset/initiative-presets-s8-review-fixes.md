---
'@cat-factory/agents': patch
---

Initiative presets — docs-refresh preset review fixes (follow-up to slice 8, #911):

- **`seedPlan` deduplicates derived target paths.** Two items whose titles slug to the same name
  under one directory (e.g. two `diagrams` items) would previously stamp the SAME `targetPath`,
  spawning two doc tasks that open competing PRs writing one file. Derived `<dir>/<slug>.md` paths
  are now uniquified (`-2`, `-3`, …) across the plan.
- **Human review gates the `merger` step, derived from the pipeline shape.** `docsReviewGates` no
  longer hand-maintains per-pipeline boolean arrays; it derives the override from each pipeline's
  `agentKinds` and places the single gate on `merger`, so the human reviews the CI-green PR right
  before it merges — the same review point for EVERY doc pipeline (previously `pl_document_quick`
  gated a mid-pipeline `doc-reviewer` that still auto-merged afterwards, contradicting the form's
  "review each documentation change before it merges" promise). Correct-by-construction against
  pipeline-shape drift instead of relying on a length drift-guard.
- **README items are writer-placed from the description, not a dead `targetPath` mechanism.** The
  planner's structured output has no `spawn` field (`INITIATIVE_PLANNER_SYSTEM_PROMPT`), so
  `coerceInitiativePlan` never carries a planner-authored path to `seedPlan` — the old
  `authored-readme` branch was inert. READMEs now name their per-service path in the item
  description (like `comments`/`business-rules`) and carry no `targetPath`.
- **`seedPlan` merges its decoration OVER any planner spawn** (so a planner-authored `agentConfig`
  survives) rather than replacing it, and reuses the package's shared `moduleSlug` for the file
  slug instead of a fourth copy of the kebab-slug helper.
- **Planner steering keeps the required `foundations` phase present** (0 items when the dirs already
  exist) rather than implying the phase may be dropped — which the exhaustive `phaseTemplate` would
  reject as a missing required phase, failing the whole plan ingest.
