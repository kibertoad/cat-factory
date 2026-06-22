---
'@cat-factory/app': patch
---

Requirements-review UX + Default Models coverage:

- Stop toasting on every saved review answer (the cleared draft already confirms the save);
  only failures still toast.
- Incorporating answers now re-reviews automatically in one action instead of leaving the
  review parked in a `merged` state behind a manual "re-review" click. If the re-review
  itself fails the review stays `merged`, where the manual re-review / redo buttons remain
  as the recovery surface.
- Surface the engine-driven kinds that still run an LLM (Spec Writer, Blueprinter, Conflict
  Resolver, CI Fixer, Fixer, Merger) in the Default Models settings so their per-workspace
  model can be pinned. They remain absent from the pipeline-builder palette (they're
  auto-inserted seeded steps, not user-addable), and the pure gates (CI, Conflicts) stay out
  since they run no model.
