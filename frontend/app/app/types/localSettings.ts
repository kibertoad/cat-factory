// Local-mode operational settings (warm-container-pool sizing + per-repo checkout reuse).
// Mirrors `@cat-factory/contracts` localSettings. A per-deployment singleton, edited in the
// dedicated local-mode settings panel — these replaced the old LOCAL_POOL_* / HARNESS_* env
// vars. There are no secrets, so the read view is the plain config. Local-mode-only (the
// warm pool is the local Docker-family runner's differentiator).
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  LocalPoolSettings,
  LocalCheckoutSettings,
  LocalSettings,
  UpdateLocalSettingsInput,
} from '@cat-factory/contracts'
