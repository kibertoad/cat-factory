// Datadog post-release-health settings shapes, mirroring `@cat-factory/contracts`
// (release.ts). Per-workspace Datadog connection (keys write-only, never read back) and
// the per-block monitor/SLO mappings the post-release-health gate reads.

/** What `GET /datadog/connection` returns — never the secret keys. */
export interface DatadogConnectionView {
  connected: boolean
  site: string | null
}

/** Set/replace the workspace's Datadog connection. */
export interface UpsertDatadogConnectionInput {
  site: string
  apiKey: string
  appKey: string
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
