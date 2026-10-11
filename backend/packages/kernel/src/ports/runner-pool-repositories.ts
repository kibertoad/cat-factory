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

/**
 * Idempotently ensures a deployment's PRE-DECLARED runner pool is registered for a workspace: the
 * runner-pool sibling of `EnvironmentHandlerSeeder` and `SharedStackSeeder`, with the same two
 * wiring sites (a boot backfill over every existing workspace, plus `WorkspaceService.create`'s
 * on-create hook).
 *
 * On a deployment where a runner pool is the only executor (stock Node), a pool is registered per
 * workspace, so without a seed every new board starts unable to run an agent until an admin fills
 * the Infrastructure form. A seed never replaces a pool a workspace already has: an admin's own
 * choice wins, and a second boot is a no-op.
 *
 * Kept free of integrations knowledge: the port speaks only `workspaceId`; the concrete seeder
 * (built over `RunnerPoolConnectionService`) lives in `@cat-factory/integrations`.
 */
export interface RunnerPoolSeeder {
  ensureForWorkspace(workspaceId: string): Promise<void>
}
