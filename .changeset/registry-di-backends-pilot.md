---
'@cat-factory/integrations': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/contracts': patch
---

Make the environment-backend and runner-backend registries app-owned (DI) instead of
module-global Maps. This is the pilot for the registry-DI migration
(`docs/initiatives/registry-di-migration.md`): the composition root now constructs each
registry instance via `createBackendRegistries()` and injects it through
`CoreDependencies`; a deployment registers a custom backend by reference
(`registry.register(provider)`), so registration no longer depends on the adapter and
server sharing the same `@cat-factory/integrations` module instance.

BREAKING (`@cat-factory/integrations`): the module-global free functions
`registerEnvironmentBackend` / `environmentBackend` / `registeredEnvironmentBackendKinds`
/ `environmentBackendKinds` / `findRepairCapableProvider` and their runner-backend
equivalents (`registerRunnerBackend` / `runnerBackend` / `registeredRunnerBackendKinds`
/ `runnerBackendKinds`) are removed. Use the new `EnvironmentBackendRegistry` /
`RunnerBackendRegistry` classes (methods `register` / `get` / `kinds` / `labelled`, plus
`findRepairCapable` on the env registry), the `defaultEnvironmentBackendRegistry()` /
`defaultRunnerBackendRegistry()` factories, or the unified `createBackendRegistries()`.
