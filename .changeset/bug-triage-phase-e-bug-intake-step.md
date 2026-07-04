---
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Bug-triage pipeline, Phase E — the `bug-intake` engine step (engine + SPA).

The recurring bug-triage pipeline's inbound entry point: each scheduled fire pulls ONE matching
open issue from the schedule's configured tracker board, claims it, and seeds the reused block
from it so every downstream step works that bug. Consumes the Phase D foundations
(`searchIssues`, `issueIntake`, `onIssuePickedUp`, `replaceForBlock`); no harness change, no
image bump.

- **`bug-intake` engine step** — a non-LLM one-shot step (the inbound dual of `tracker`),
  registered as a `StepHandler` in the engine so it never reaches a container. It resolves the
  schedule's `issueIntake` config by block, searches the source (predicates pushed into the
  vendor query), dedupes against every already-worked issue in ONE batched projection read,
  picks the oldest match, imports + **replace-links** it onto the block, rewrites the block's
  title/description from it, and posts the best-effort "taken by cat-factory" pickup writeback.
  The read-and-claim logic lives in a new provider-neutral `BugIntakeService`
  (`@cat-factory/integrations`), wired into the engine only when task sources are configured.
- **No-match no-op** — when nothing qualifies (or no task source is wired), the run completes
  SUCCESSFULLY with every remaining step marked `skipped` (there is nothing to fix) and no
  notification — the outcome is visible in the schedule's run history. A scoped early-complete
  that reuses the existing skip/finalize machinery, not a new gate archetype.
- **Schedule validation** — `RecurringPipelineService.create`/`update` now require an
  `issueIntake` config, pointed at a connected task source, whenever the pipeline carries an
  enabled `bug-intake` step (validated at both boundaries, including clearing the config on an
  existing bug-intake schedule) — otherwise every fire would silently no-op.
- **SPA** — `RecurringPipelineModal.vue` gains an issue-intake section (source picker from the
  connected task sources, per-vendor board field, and the title/labels/issue-type predicates)
  shown when the picked pipeline has a `bug-intake` step, with i18n across all locales.
- **Conformance** — intake pickup (a matching issue is imported, linked and seeds the block),
  the no-match no-op (the run completes with the remaining steps skipped), and the
  missing-config rejection are asserted on every runtime against a fake task source.
