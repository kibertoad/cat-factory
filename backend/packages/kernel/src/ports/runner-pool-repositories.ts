// Persistence port for the self-hosted runner-pool integration. The worker
// implements this against D1 (migration 0013); tests can supply an in-memory
// fake. Rows are scoped by workspace, mirroring the environment-connection
// repository. The management-API secret bundle is stored as opaque ciphertext
// (see the SecretCipher port) — this record never holds plaintext secrets.

/**
 * A workspace's binding to an "agent runner backend" — the place repo-operating
 * coding jobs run. This generalises the original self-hosted runner pool into a
 * discriminated backend: `kind` selects WHICH backend (`manifest` = the BYO
 * scheduler HTTP pool, `kubernetes` = a native kube-apiserver pod runner, future
 * `nomad`/`eks`/…), and `configJson` carries that kind's serialized config (the
 * discriminated `RunnerBackendConfig`). The provider-registry seam in
 * `@cat-factory/integrations` maps `kind` → a `RunnerTransport`. The encrypted
 * per-tenant secret bundle (the backend's credentials — a scheduler API key, a
 * Kubernetes ServiceAccount token, …) is decrypted only in-memory, at call time,
 * by the dispatch/poll path.
 */
export interface RunnerPoolConnectionRecord {
  workspaceId: string
  /** Which runner backend this row configures (`manifest` | `kubernetes` | …). */
  kind: string
  providerId: string
  label: string
  /** The backend's primary URL (a manifest's `baseUrl`, a cluster's apiserver URL). */
  baseUrl: string
  /**
   * The serialized per-kind config: the discriminated `RunnerBackendConfig` JSON.
   * (Physical column keeps its historical `manifest_json` name — it now holds the
   * whole discriminated config, not just a manifest.)
   */
  configJson: string
  /** Ciphertext of the `{ key: value }` secret bundle (SecretCipher envelope). */
  secretsCipher: string
  createdAt: number
  /** Set when the workspace unregisters (tombstone). */
  deletedAt: number | null
}

export interface RunnerPoolConnectionRepository {
  /** The workspace's live connection, or null if not registered. */
  getByWorkspace(workspaceId: string): Promise<RunnerPoolConnectionRecord | null>
  /** Create or replace the live connection for a workspace. */
  upsert(record: RunnerPoolConnectionRecord): Promise<void>
  /** Tombstone the workspace's connection. */
  softDelete(workspaceId: string, at: number): Promise<void>
}
