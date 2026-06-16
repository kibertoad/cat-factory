// Persistence port for the self-hosted runner-pool integration. The worker
// implements this against D1 (migration 0013); tests can supply an in-memory
// fake. Rows are scoped by workspace, mirroring the environment-connection
// repository. The management-API secret bundle is stored as opaque ciphertext
// (see the SecretCipher port) — this record never holds plaintext secrets.

/**
 * A workspace's binding to a self-hosted runner pool: the validated manifest and
 * the encrypted per-tenant secret bundle (the scheduler-API credentials). The
 * bundle is decrypted only in-memory, at call time, by the dispatch/poll path.
 */
export interface RunnerPoolConnectionRecord {
  workspaceId: string
  providerId: string
  label: string
  baseUrl: string
  /** The validated manifest, serialized as JSON. */
  manifestJson: string
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
