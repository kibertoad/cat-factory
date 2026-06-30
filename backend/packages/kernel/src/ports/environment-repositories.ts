import type { EnvironmentStatus } from '../domain/types.js'

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
  /**
   * Which backend kind interprets this connection (`manifest` | `kubernetes` | …).
   * Selects the registered environment-backend provider; absent rows default to
   * `manifest`. Mirrors `RunnerPoolConnectionRecord.kind`.
   */
  kind: string
  providerId: string
  label: string
  baseUrl: string
  /**
   * The stored manifest, serialized as JSON. For a native backend (e.g. `kubernetes`)
   * the per-workspace settings ride the manifest's `providerConfig` bag — the backend
   * registry builds + reads it. See `backend/docs/native-environment-adapter.md`.
   */
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

// ---------------------------------------------------------------------------
// Per-USER infra handler overrides (local mode) — the per-user layer over the
// workspace's per-type handlers. Keyed by (userId, workspaceId, provisionType,
// manifestId). `manifestId` is `''` (not null) for non-custom types so it can sit in
// the composite primary key cleanly on both SQLite and Postgres; the record maps the
// empty string to `null`. Mirrors `local_model_endpoints` (a normal per-user table that
// exists in BOTH runtimes); the local-only behaviour is enforced at the controller mount.
// See docs/initiatives/per-service-provision-types.md.
// ---------------------------------------------------------------------------

/** A user's override of how a provision type is handled, for a given workspace. */
export interface EnvironmentUserHandlerRecord {
  userId: string
  workspaceId: string
  /** The provision type this handler serves (`kubernetes` | `docker-compose` | `custom` | …). */
  provisionType: string
  /** For `custom`: which manifest id this handler is for; `null` otherwise. */
  manifestId: string | null
  /** The engine that handles the type (`local-docker` | `local-k3s` | `remote-kubernetes` | `remote-custom`). */
  engine: string
  providerId: string
  label: string
  baseUrl: string
  /** The serialized `InfraHandlerConfig` (the engine connection, sans secrets). */
  handlerJson: string
  /** For `remote-custom`: the manifest id this provider accepts; `null` otherwise. */
  acceptsManifestId: string | null
  /** Ciphertext of the `{ key: value }` secret bundle (SecretCipher envelope). */
  secretsCipher: string
  createdAt: number
  updatedAt: number
}

export interface EnvironmentUserHandlerRepository {
  /** Every override the user has set for a workspace (batched — no per-type point reads). */
  listByUserWorkspace(userId: string, workspaceId: string): Promise<EnvironmentUserHandlerRecord[]>
  /** Insert or replace one override (keyed by user+workspace+type+manifestId). */
  upsert(record: EnvironmentUserHandlerRecord): Promise<void>
  /** Remove one override. */
  remove(
    userId: string,
    workspaceId: string,
    provisionType: string,
    manifestId: string | null,
  ): Promise<void>
}

// ---------------------------------------------------------------------------
// Workspace-defined custom-manifest-type catalog entries. The full catalog a service
// can declare is the union of these rows with the programmatically-registered providers
// (resolved in the service layer). Keyed by (workspaceId, manifestId).
// ---------------------------------------------------------------------------

/** A workspace-authored custom manifest type. */
export interface CustomManifestTypeRecord {
  workspaceId: string
  manifestId: string
  label: string
  acceptsInputHint: string | null
  description: string | null
  createdAt: number
  updatedAt: number
}

export interface CustomManifestTypeRepository {
  /** Every workspace-defined custom manifest type (batched). */
  listByWorkspace(workspaceId: string): Promise<CustomManifestTypeRecord[]>
  /** Insert or replace a workspace-defined custom manifest type. */
  upsert(record: CustomManifestTypeRecord): Promise<void>
  /** Remove a workspace-defined custom manifest type. */
  remove(workspaceId: string, manifestId: string): Promise<void>
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
  /** The service's declared provision type this env was stood up for; null for legacy rows. */
  provisionType: string | null
  /** The resolved engine that handled the provisioning; null for legacy rows. */
  engine: string | null
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
    | 'provisionType'
    | 'engine'
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
