---
"@cat-factory/app": minor
---

Adopt modular-react#83 (production-feedback items 3 & 4) in the environment-setup journey. Bump `@modular-frontend/core` (0.6.0), `@modular-frontend/journeys-engine` (1.9.0), `@modular-vue/core` (1.5.0) and `@modular-vue/journeys` (1.4.0), then drop the `defineModule` `as const` narrowing workarounds (item 3, literal inference) and derive the wizard's step order + a new "Step X of N" progress indicator from the annotated transition graph via `useJourneyProgress` / `resolveStepSequence` instead of a hand-maintained `ENV_STEP_ORDER` (item 4).
