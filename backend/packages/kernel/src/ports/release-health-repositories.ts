// Persistence ports for the post-release-health (observability) integration. Both
// mirror across the D1 (Cloudflare) and Drizzle/Postgres (Node) facades (runtime
// parity is mandatory). Credentials are sealed at rest by the facade's SecretCipher;
// the records here carry the sealed blob (never plaintext) plus a non-secret summary.

/**
 * The observability vendors a workspace can connect for post-release health. Datadog
 * is the only adapter today; the connection is keyed by provider so a second vendor is
 * just a new adapter (see the provider registry in `@cat-factory/integrations`).
 */
export type ObservabilityProviderKind = 'datadog'

/** A workspace's observability connection. Exactly one per workspace. */
export interface ObservabilityConnectionRecord {
  workspaceId: string
  /** Which observability vendor this connection points at. */
  provider: ObservabilityProviderKind
  /**
   * Sealed (by the facade SecretCipher) JSON of the provider-specific credentials —
   * e.g. for Datadog `{ site, apiKey, appKey }`. Opaque to everything but the provider
   * adapter, which decrypts it at probe time.
   */
  credentials: string
  /**
   * Non-secret display summary as a JSON object (e.g. `{"site":"datadoghq.com"}`), so
   * the connection view can show provider context without ever decrypting the secret.
   */
  summary: string
  createdAt: number
  updatedAt: number
}

export interface ObservabilityConnectionRepository {
  get(workspaceId: string): Promise<ObservabilityConnectionRecord | null>
  upsert(record: ObservabilityConnectionRecord): Promise<void>
  delete(workspaceId: string): Promise<void>
}

/**
 * Per-repo/service release-health config: which monitors/SLOs map to a block (the
 * service frame a run's repo target resolves to). Drives the gate's `probe` reads for
 * that run. Vendor-neutral — the ids are interpreted by whichever provider is connected.
 */
export interface ReleaseHealthConfigRecord {
  workspaceId: string
  /** The service frame (or task) block these monitors/SLOs belong to. */
  blockId: string
  /** Monitor ids to watch. */
  monitorIds: string[]
  /** SLO ids to watch. */
  sloIds: string[]
  /** Optional env tag (e.g. 'prod') used when querying logs/errors. */
  envTag: string | null
  createdAt: number
  updatedAt: number
}

export interface ReleaseHealthConfigRepository {
  getByBlock(workspaceId: string, blockId: string): Promise<ReleaseHealthConfigRecord | null>
  listByWorkspace(workspaceId: string): Promise<ReleaseHealthConfigRecord[]>
  upsert(record: ReleaseHealthConfigRecord): Promise<void>
  delete(workspaceId: string, blockId: string): Promise<void>
}
