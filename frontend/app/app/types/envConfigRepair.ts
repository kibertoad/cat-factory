// ---------------------------------------------------------------------------
// Environment-provider config-repair domain types. Mirrors the
// `@cat-factory/contracts` env-config-repair schemas so backend payloads drop
// straight into the Pinia store.
//
// A config-repair run is the durable agent fallback dispatched when mechanical
// provider-config bootstrap can't produce a valid config: a coding agent fixes the
// provider's config file in an existing repo and pushes the fix back, then the
// backend re-validates. It has no board block — it's surfaced only on the
// infrastructure-providers window that triggered it.
// ---------------------------------------------------------------------------
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type { EnvConfigRepairStatus, EnvConfigRepairJob } from '@cat-factory/contracts'
