---
"@cat-factory/contracts": minor
"@cat-factory/kernel": minor
"@cat-factory/integrations": minor
"@cat-factory/app": minor
---

Surface optional/default config values and unconfigured-provider warnings for the
ephemeral-environment and self-hosted runner-pool providers.

- `ProviderConfigField` gains an optional `default`; a field that has one is optional
  (the connect form shows it blank with a "defaulted to …" hint and falls back to it).
- `ProviderDescriptor` gains `missingRequired` (required-without-default keys not yet
  supplied — the loud-banner signal) and an optional `manifestTemplate` scaffold.
- A native `EnvironmentProvider` / `RunnerPoolProvider` may implement
  `describeManifestTemplate()` so the SPA renders a flat `describeConfig` connect form yet
  still persists a single full manifest (per `backend/docs/native-environment-adapter.md`).
- Both connection services compute `missingRequired` server-side from the saved secret
  bundle + manifest `providerConfig`.
- Frontend: a generic descriptor-driven connect panel for both providers (under
  Settings ▸ Integrations) and a loud `ProviderConfigBanner` that fires when a provider is
  wired for the instance but mandatory fields are missing.
