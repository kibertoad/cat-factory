---
'@cat-factory/app': patch
---

refactor(app): split the `ui.ts` store and finish the plain-upsert store adoption

Two refactoring candidates, both internal with no behaviour change:

- **Candidate #4 — split the `ui.ts` store.** The 828-line god-store (40+ unrelated UI
  concerns) is decomposed into three cohesive slices under `stores/ui/`: `navigation.ts`
  (selection / focus / zoom / LOD), `resultViews.ts` (the `dispatchStepView` / `ui.resultView`
  overlay seam + the observability + Kaizen panels), and `modals.ts` (every modal / panel
  open-close flag, hub markers, deep-link params, and the startup + AI-onboarding advisories).
  `ui.ts` is now a thin facade composing the three behind the SAME public surface (all 184
  keys, verified identical), so every `useUiStore()` consumer is untouched.
- **Candidate #3 — finish the `useUpsertList` adoption.** The `agentRuns` store's
  `envConfigRepairJobs` list (the last plain, unguarded find-by-id upsert) now routes through
  the shared `useUpsertList` composable instead of a hand-rolled `findIndex` block.
