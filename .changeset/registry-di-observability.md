---
'@cat-factory/integrations': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Finish the registry-DI migration: normalize the observability-provider registry to the same
app-owned class shape as the other registries. `ObservabilityProviderRegistry` is now a class
(`register`/`get`/`kinds`) and `defaultObservabilityRegistry()` a factory that pre-loads the
Datadog adapter, replacing the interim `Partial<Record<kind, factory>>` record — a breaking
change to the exported surface (pre-1.0, no shim). Each facade now injects
`defaultObservabilityRegistry()` into `RegistryReleaseHealthProvider`. The initiative's every
module-global plugin registry is now app-owned DI; the tracker is converted to
`backend/docs/adr/0028-registry-di.md`.
