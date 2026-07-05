---
'@cat-factory/contracts': minor
---

Stack recipes & shared stacks (slice 7, part 1): the analyst draft-merge core.

Adds `mergeAnalystRecipeDraft(recommendation, draft)` — the pure function that combines the deterministic provisioning recommendation with the opt-in environment analyst's `AnalystRecipeDraft` into a single reviewable recipe with per-field provenance. This is the "review recipe" input the setup wizard renders (the piece slice 8 deferred here).

The rule: **deterministic detector facts win where both produce a field; analyst-only fields (setup steps, health gate, prerequisites the checkout-free scan can't see) fill the gaps.** Each populated field carries the winning source's provenance — detector confidence + note, or the analyst's rationale + source citations — and the analyst's verbatim notes ride along so the wizard can surface granular per-step provenance (e.g. `setupSteps[2]`).

- `mergeAnalystRecipeDraft` + the `MergedRecipeDraft` / `MergedRecipeField` / `RecipeFieldOrigin` view-model types + the `MERGEABLE_RECIPE_FIELDS` field list (`environment-analyst-merge.ts`).
- Placed in `@cat-factory/contracts` beside the types it merges (both inputs are contract types) rather than in `integrations` beside the detector, so the SPA wizard consumes it client-side with no extra endpoint — the same shared-pure-helper shape as `resolveFrontendBindings` / `buildFrontendRunNotes`. Unit-tested from `@cat-factory/integrations` (contracts has no test runner), the pattern by which `buildFrontendRunNotes` is tested from a consumer.

Pure + no IO, no persistence change. The wizard UI + the "run deep analysis" trigger are the remainder of slice 7.
