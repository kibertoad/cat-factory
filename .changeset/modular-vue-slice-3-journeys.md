---
'@cat-factory/app': minor
---

Adopt modular-vue in the Nuxt layer (slice 3: wizards → journeys, pilot). The
upstream Vue journeys binding shipped (`@modular-vue/journeys@1.1.0`, with the
`@modular-vue/{core,vue,runtime}@1.2.0` / `nuxt@0.2.0` bump), and the
**environment-setup wizard** is the first flow converted onto it.

The wizard's step NAVIGATION — the hand-rolled `STEP_ORDER` + `step` ref +
`goToStep` that lived in `stores/environmentWizard.ts` — is now the
`environment-setup` journey (`app/modular/journeys/environmentSetup.ts`, wired via
`.use(journeysPlugin())` in the registry). `EnvironmentSetupWizard.vue` is now pure
modal + stepper chrome hosting `<JourneyHost>`/`<JourneyOutlet>`; the four step
sections became `components/environments/steps/Env{Pick,Review,Preflight,Save}Step.vue`,
each firing a journey exit (`select` / `advance`) to advance. The per-step data +
async actions (detect / analysis / recipe / preflight / save / trial) stay in the
`environmentWizard` store, which the step components still drive; the store keeps
those and exposes `beginForFrame`, dropping only the navigation. All `env-setup-*`
`data-testid`s are preserved.

Journey state is persisted through the new `journeyPersistence` Pinia store
(`createPiniaJourneyPersistence`, keyed by the target frame), so closing and
reopening the wizard for the same frame RESUMES at the step it was left on and a
completed flow clears its blob — a resume the reset-on-every-open store couldn't
offer (session-scoped; a full reload starts fresh).

Dependency bumps ride along: Nuxt `4.4.8 → 4.5.0` (which pulls `vue-router@^5.2.0`,
pinned to a single version by a `vue-router: 5.2.0` pnpm override so it doesn't
duplicate against `@nuxtjs/i18n`), and Pinia `3 → 4` (`@pinia/nuxt@1.0.1`).
`vue` / `vue-router` / `pinia` each resolve to a single version.
