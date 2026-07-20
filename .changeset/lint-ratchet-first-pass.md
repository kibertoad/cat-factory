---
'@cat-factory/orchestration': patch
'@cat-factory/agents': patch
'@cat-factory/observability-otel': patch
---

First pass on the oxlint complexity/size ratchet (no behavioural change):

- Tighten the free size ceilings now that the conformance god-file split dropped their floors:
  `max-lines` 3119 → 2802 and `max-lines-per-function` 3103 → 2453.
- Complete `max-nested-callbacks` (6 → 4, its final target) by extracting the spec-id flatMap
  chain in `render.test.ts` into a helper.
- Lower `max-depth` 6 → 5 by extracting the per-metric fold in the OTEL conformity test and the
  per-target recommendation application in `RequirementReviewService` (`applyRecommendationToTarget`)
  out of their deeply-nested loops.
- Add `scripts/lint-limits-report.mjs`, a floor-finder that reports each ratcheted rule's live
  ceiling, actual floor, and top offenders to plan subsequent slices.
