import type { EnvironmentStatus } from '../domain/types'

// Persistence ports for the ephemeral-environment integration. The worker
// implements these against D1 (migration 0008); tests can supply in-memory
// fakes. All rows are scoped by workspace, mirroring the board / GitHub /
// Confluence repositories. Credentials are stored as opaque ciphertext (see the
// SecretCipher port) — these records never hold plaintext secrets.

/**
 * A workspace's binding to an environment provider: the validated manifest and
 * the encrypted per-tenant secret bundle (the management-API credentials). The
 * bundle is decrypted only in-memory, at call time, by the provisioning path.
 */
export interface EnvironmentConnectionRecord {
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

export interface EnvironmentConnectionRepository {
  /** The workspace's live connection, or null if not registered. */
  getByWorkspace(workspaceId: string): Promise<EnvironmentConnectionRecord | null>
  /** Create or replace the live connection for a workspace. */
  upsert(record: EnvironmentConnectionRecord): Promise<void>
  /** Tombstone the workspace's connection. */
  softDelete(workspaceId: string, at: number): Promise<void>
}

/**
 * A provisioned environment, projected locally. `accessCipher` holds the
 * encrypted per-env access creds (what the tester uses); `provisionFieldsCipher`
 * holds the encrypted fields captured at provision time (needed to interpolate
 * status/teardown calls). Both are SecretCipher envelopes, never plaintext.
 */
export interface EnvironmentRecord {
  id: string
  workspaceId: string
  blockId: string | null
  executionId: string | null
  providerId: string
  externalId: string | null
  url: string | null
  status: EnvironmentStatus
  accessCipher: string | null
  provisionFieldsCipher: string | null
  createdAt: number
  expiresAt: number | null
  lastError: string | null
  deletedAt: number | null
}

export type EnvironmentRecordPatch = Partial<
  Pick<
    EnvironmentRecord,
    | 'externalId'
    | 'url'
    | 'status'
    | 'accessCipher'
    | 'provisionFieldsCipher'
    | 'expiresAt'
    | 'lastError'
  >
>

export interface EnvironmentRegistryRepository {
  insert(record: EnvironmentRecord): Promise<void>
  update(workspaceId: string, id: string, patch: EnvironmentRecordPatch): Promise<void>
  get(workspaceId: string, id: string): Promise<EnvironmentRecord | null>
  /** The live environment provisioned for a board block — the discovery key. */
  getByBlock(workspaceId: string, blockId: string): Promise<EnvironmentRecord | null>
  /** Every live environment in the workspace. */
  listByWorkspace(workspaceId: string): Promise<EnvironmentRecord[]>
  /** Live environments whose TTL has elapsed (all workspaces), for the cron sweep. */
  listExpired(nowEpochMs: number): Promise<EnvironmentRecord[]>
  /** Tombstone an environment record. */
  softDelete(workspaceId: string, id: string, at: number): Promise<void>
}
