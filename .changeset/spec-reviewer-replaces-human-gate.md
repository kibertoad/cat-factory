---
'@cat-factory/kernel': minor
'@cat-factory/app': patch
---

Spec Writer no longer requires human review by default; its companion (renamed
**Spec Reviewer**) is the optional automatic quality gate instead.

- **Default pipelines.** The `spec-writer` step is no longer human-gated. In
  "Full build" (`pl_full`) the `spec-companion` is now inserted right after the
  `spec-writer` (which runs before the architect on the shared work branch), ungated,
  so the spec is reviewed, rated and — below threshold — the spec-writer is
  automatically re-invoked with the reviewer's feedback folded in, instead of pausing
  for a human; the architecture human gate is unchanged. In "Complex fullstack
  feature" (`pl_fullstack`) the `spec-companion` step is likewise ungated (the
  architecture gate, on `architect-companion`, is unchanged).
- No engine change: this reuses the existing companion review/rework loop
  (`evaluateCompanion`), whose configurable per-step threshold (default 0.8,
  overridable in the pipeline builder) governs when the spec-writer is looped back.
- The `spec-companion` palette label is renamed from "Spec Companion" to
  **"Spec Reviewer"** and its description updated to reflect that it replaces the
  human spec review rather than preceding it.
- Cross-runtime conformance gains an assertion that a `spec-writer` → `spec-companion`
  pipeline reworks the spec automatically and completes with no `waiting_decision`
  human gate.

Breaking: the `seedPipelines()` catalog only seeds a workspace at creation, so
existing workspaces keep their previously-seeded `pl_full` / `pl_fullstack` rows
(still gating the spec, and without the `builtin` flag) — there is no re-seed or
migration. Per the pre-1.0 no-backwards-compat policy that stale shape is acceptable;
only newly-created workspaces get the ungated, built-in-flagged catalog.
