// Per-account (deployment-wide) integration settings. Mirrors
// `@cat-factory/contracts` accountSettings. Secrets are write-only — the read view
// returns only `config` + a non-secret presence `summary`.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  SlackOAuthSecret,
  WebSearchSecret,
  AccountSettingsConfig,
  AccountSettingsSummary,
  AccountSettingsView,
  UpdateAccountSettingsInput,
  ContentStorageBackend,
  ContentStorageConfig,
  ContentStorageSummary,
  ContentStorageCapability,
  // Account-wide model-family allow/block policy.
  ModelFamily,
  ModelFamilyPolicy,
  ModelPolicyMode,
  AccountRegion,
} from '@cat-factory/contracts'
