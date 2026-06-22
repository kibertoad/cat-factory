---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Requirements review: dedicated window + iterative convergence loop, and a universal
result-view seam.

The pipeline's `requirements-review` gate step no longer runs as a prose agent behind the
generic approve/reject panel. It now drives the purpose-built structured review window: the
reviewer raises findings (each with a severity), the human answers or dismisses them, an
incorporation companion folds the answers into one standard-format document, and the
reviewer re-reviews that document. The cycle repeats until the reviewer converges (or every
remaining finding is dismissed). The human can reject a bad merge and redo the incorporation
with a freeform "do it differently" comment.

Two new per-task knobs live on the merge-threshold preset:

- `maxRequirementIterations` (default 3) — reviewer passes allowed before the run stops on
  its own and the human picks: one more round / proceed anyway (with the last incorporated
  document) / stop and reset the task to phase zero (editable; the last incorporated
  document stays on the inspector as a base).
- `maxRequirementConcernAllowed` (default `none`) — when every outstanding finding is at or
  below this severity, the findings are recorded but the run advances automatically (no
  human gate, companion skipped).

Frontend gains a UNIVERSAL result-view seam: an agent archetype can declare a `resultView`
id and register a window component, and the renderer dispatches to it instead of the generic
prose panel — requirements review is the first consumer, not a hardcoded special case.

Breaking (pre-1.0, acceptable): the requirements-rework quality-companion gate is removed
(convergence is now reviewer-driven), so `RequirementReview` drops `companionVerdicts` and
gains `iteration`/`maxIterations` and the `merged`/`exceeded` statuses; the
`requirement_reviews` and `merge_threshold_presets` tables change shape on both runtimes
(D1 migration `0044` ⇄ a generated Drizzle migration — additive `ALTER`s: `companion` is
dropped, the new columns take defaults, so existing rows are not lost but their old review
state is re-created on the next run).
