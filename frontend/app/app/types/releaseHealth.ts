// Post-release-health (observability) settings shapes, mirroring `@cat-factory/contracts`
// (release.ts). Per-workspace observability connection (provider + credentials, write-only,
// never read back) and the per-block monitor/SLO mappings the post-release-health gate reads.

/** Observability vendors a workspace can connect (extensible; Datadog today). */
export type ObservabilityProviderKind = 'datadog'

/** What `GET /observability/connection` returns — never the secret keys. */
export interface ObservabilityConnectionView {
  connected: boolean
  provider: ObservabilityProviderKind | null
  /** Non-secret display fields, e.g. `{ site }` for Datadog. */
  summary: Record<string, string> | null
}

/** Set/replace the workspace's observability connection. */
export interface UpsertObservabilityConnectionInput {
  provider: ObservabilityProviderKind
  credentials: {
    site: string
    apiKey: string
    appKey: string
  }
}

/** A block's monitor/SLO mapping for the post-release-health gate. */
export interface ReleaseHealthConfig {
  blockId: string
  monitorIds: string[]
  sloIds: string[]
  envTag: string | null
}

/** Create/replace a block's release-health config. */
export interface UpsertReleaseHealthConfigInput {
  monitorIds?: string[]
  sloIds?: string[]
  envTag?: string | null
}
