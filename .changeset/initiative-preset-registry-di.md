---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/contracts': patch
---

Initiative-preset registry → app-owned DI (slice 5 of the custom-initiative-definitions
initiative; registry-DI-migration "Initiative presets" row). The module-global initiative-preset
registry is replaced by an app-owned `InitiativePresetRegistry` instance the composition root news,
threads through `CoreDependencies`, and re-exposes on `Core` — mirroring the agent-kind registry.
This removes the shared process state and the external-adapter module-identity gotcha: a deployment
registers its own presets by reference on the instance the facade injects.

BREAKING: the free `@cat-factory/kernel` exports `registerInitiativePreset`,
`registerInitiativePresets`, `getInitiativePreset`, `allInitiativePresets`,
`initiativePresetDescriptors`, and `clearRegisteredInitiativePresets` are removed. Use the new
`InitiativePresetRegistry` class (kernel) + `defaultInitiativePresetRegistry()` factory
(`@cat-factory/agents`, preloads the built-in generic / docs-refresh / tech-migration presets)
instead, and inject it via the facade's composition seam — `createApp({ overrides: {
initiativePresetRegistry } })` on the Worker, or the `initiativePresetRegistry` option on `start()`
/ `startLocal()`. `registerDocsRefreshPreset` / `registerTechMigrationPreset` now take the registry
as a parameter (no bottom-of-module self-registration). No data migration — pre-1.0, no back-compat.
