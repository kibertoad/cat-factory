// Post-release-health (observability) settings shapes. Per-workspace observability
// connection (provider + credentials, write-only, never read back) and the per-block
// monitor/SLO mappings the post-release-health gate reads.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).
// The historical frontend name `ReleaseHealthConfig` is the contract's
// `ReleaseHealthConfigWire`.

export type {
  ObservabilityProviderKind,
  ObservabilityConnectionView,
  UpsertObservabilityConnectionInput,
  UpsertReleaseHealthConfigInput,
  ReleaseHealthConfigWire as ReleaseHealthConfig,
} from '@cat-factory/contracts'
