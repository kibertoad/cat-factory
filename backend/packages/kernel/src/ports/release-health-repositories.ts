// Persistence ports for the Datadog post-release-health integration. Both mirror
// across the D1 (Cloudflare) and Drizzle/Postgres (Node) facades (runtime parity is
// mandatory). Credentials are sealed at rest by the facade's SecretCipher; the
// records here carry plaintext only in memory.

/** A workspace's Datadog connection. Exactly one per workspace. */
export interface DatadogConnectionRecord {
  workspaceId: string
  /** Datadog site host, e.g. 'datadoghq.com' | 'datadoghq.eu' | 'us5.datadoghq.com'. */
  site: string
  /** Datadog API key (DD-API-KEY). */
  apiKey: string
  /** Datadog application key (DD-APPLICATION-KEY). */
  appKey: string
  createdAt: number
  updatedAt: number
}

export interface DatadogConnectionRepository {
  get(workspaceId: string): Promise<DatadogConnectionRecord | null>
  upsert(record: DatadogConnectionRecord): Promise<void>
  delete(workspaceId: string): Promise<void>
}

/**
 * Per-repo/service release-health config: which Datadog monitors/SLOs map to a
 * block (the service frame a run's repo target resolves to). Drives the gate's
 * `probe` reads for that run.
 */
export interface ReleaseHealthConfigRecord {
  workspaceId: string
  /** The service frame (or task) block these monitors/SLOs belong to. */
  blockId: string
  /** Datadog monitor ids to watch. */
  monitorIds: string[]
  /** Datadog SLO ids to watch. */
  sloIds: string[]
  /** Optional env tag (e.g. 'prod') used when querying logs/errors. */
  envTag: string | null
  /** Optional Bugsnag project id for error evidence. */
  bugsnagProject: string | null
  createdAt: number
  updatedAt: number
}

export interface ReleaseHealthConfigRepository {
  getByBlock(workspaceId: string, blockId: string): Promise<ReleaseHealthConfigRecord | null>
  listByWorkspace(workspaceId: string): Promise<ReleaseHealthConfigRecord[]>
  upsert(record: ReleaseHealthConfigRecord): Promise<void>
  delete(workspaceId: string, blockId: string): Promise<void>
}
