---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Make the ephemeral-environment AND self-hosted runner-pool backend registries extensible to
custom third-party kinds, so a single-tenant / self-hosted deployment can register a bespoke
provider **programmatically** (an import side effect via `registerEnvironmentBackend` /
`registerRunnerBackend`), mirroring custom agent kinds. This restores the capability the
removed `buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`
deployment-wide injection used to provide, and serves both single- and multi-tenant.

- **Contracts (breaking, additive):** `environmentBackendConfigSchema` /
  `runnerBackendConfigSchema` gain a generic custom-kind member (a lower-kebab `kind` slug,
  guarded to exclude the reserved built-ins, carrying the subsystem manifest body), so a
  custom kind's connect config validates with no new variant. The workspace snapshot gains
  `environmentBackendKinds` / `runnerBackendKinds`, and the describe routes accept an optional
  `kind` query. Existing `manifest`/`kubernetes` rows still parse — no migration.
- **Registries:** `EnvironmentBackendProvider` / `RunnerBackendProvider` `kind` is now an open
  `string` with an optional `displayLabel`; new `environmentBackendKinds()` /
  `runnerBackendKinds()` accessors. `describeProvider(workspaceId, kind?)` can describe a
  registered kind before it is connected.
- **Frontend:** the provider-connect backend-kind selector is snapshot-driven (built-in
  fallback) instead of a hardcoded `manifest`/`kubernetes` list; a custom kind's flat-form /
  manifest-editor save is tagged with its slug.
- A custom kind requires a per-workspace connection (the encrypted-secret + `providerConfig`
  anchor) exactly like the built-ins. The `runnerPoolProvider` facade option is unchanged and
  remains the HTTP-pool override for the manifest backend, NOT the custom-kind seam.
