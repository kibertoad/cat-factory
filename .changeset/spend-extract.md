---
"@cat-factory/spend": minor
"@cat-factory/core": patch
"@cat-factory/worker": patch
---

Extract `@cat-factory/spend` — pricing tables and spend metering/gating are now a standalone package. `@cat-factory/core` re-exports the full public surface for backward compatibility; the acceptance test and worker's spending config now import directly from `@cat-factory/spend`, narrowing the CI container-acceptance gate from `backend/packages/core/**` to `backend/packages/spend/**`.
