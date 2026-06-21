---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/prompt-fragments': minor
'@cat-factory/app': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/executor-harness': minor
---

Companion agents + acceptance-test rework (the structured spec replaces the
client-only scenario surface), plus a vocabulary split so "requirements" (the
linked-prose context review) and "spec" (the structured in-repo document) are no
longer the same word.

- **Companion agents.** A companion grades a prior producer step's output, returns
  an overall quality rating (0..1), and — below the step's threshold (default 0.8) —
  loops the producer back for automatic rework BEFORE a human is asked, failing the
  run (`companion_rejected`) once the rework budget is spent. Companions declare an
  allow-list of target kinds and are placed as their own chain step in the pipeline
  builder (with a per-step `thresholds` array, parallel to `gates`). Built-ins:
  `architect-companion`, `spec-companion`, and `reviewer` reframed as the coder's
  companion. Wired into `ExecutionService` (`evaluateCompanion` + a unified rework
  revision path shared with the human "request changes" flow).
- **Companion-gated requirements rework.** The per-block requirements review's
  rework step is now gated by a quality companion: below threshold the reworked doc
  is NOT accepted (the review stays `ready`), and the companion's challenge is
  surfaced in the review window and fed into the next rework. Persisted on
  `requirement_reviews.companion` (D1 migration 0036 + Drizzle).
- **Acceptance tests via the spec.** The client-only scenarios store/UI is removed;
  the structured Given/When/Then acceptance scenarios live in the service spec
  (authored by the `spec-writer`, reviewed on its gated step) and are derived into
  Gherkin. The redundant `acceptance` polish agent is dropped; `playwright` still
  writes the runnable tests. `spec-writer`'s prompt now treats complete
  acceptance-scenario coverage as a first-class deliverable.
- **`architect` is now a container agent** that explores the repo (read-only, like
  `analysis`) before proposing.
- **Rename: requirements → spec** for the structured family. In-repo `requirements/`
  → `spec/` (`spec.json`, `spec/features/*.feature`; legacy `requirements/`
  relocated on first run); `RequirementsDoc` → `SpecDoc`; `requirements-writer` →
  `spec-writer`; the pipeline analyst `requirements` → `requirements-review`;
  `pl_requirements` → `pl_spec`. The context-review family (`RequirementReview*`,
  `requirement_reviews`) keeps the `requirements` name.

The harness image changed (the `/requirements` endpoint + `requirements/` paths
became `/spec` + `spec/`), so `@cat-factory/executor-harness` and the
`deploy/backend` image tag are bumped to 1.0.6 and must be re-published + rolled out.
