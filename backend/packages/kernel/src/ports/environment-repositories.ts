import type { EnvironmentStatus } from '../domain/types.js'

// Persistence ports for the ephemeral-environment integration. The worker
// implements these against D1 (migration 0008); tests can supply in-memory
// fakes. All rows are scoped by workspace, mirroring the board / GitHub /
// Confluence repositories. Credentials are stored as opaque ciphertext (see the
// SecretCipher port) — these records never hold plaintext secrets.

/**
 * A workspace's per-provision-type infra HANDLER: how a service's declared provision type
 * (the "what + where") is stood up (the "how"). Keyed by `(workspaceId, provisionType,
 * manifestId)` — a workspace declares one handler per type, plus one per pinned custom
 * `manifestId`. The serialized {@link handlerJson} (the engine connection, sans secrets) and
 * the encrypted secret bundle are decrypted/built only in-memory, at provision time. See
 * docs/initiatives/per-service-provision-types.md.
 *
 * `manifestId` is `null` for the non-custom types; on SQLite/Postgres it sits in the
 * composite primary key as the `''` sentinel (the repos map `'' ⇄ null`), exactly like
 * {@link EnvironmentUserHandlerRecord}.
 */
export interface EnvironmentConnectionRecord {
  workspaceId: string
  /** The provision type this handler serves (`kubernetes` | `docker-compose` | `custom`). */
  provisionType: string
  /** For `custom`: which manifest id this handler is keyed to; `null` otherwise. */
  manifestId: string | null
  /** The engine that handles the type (`local-docker` | `local-k3s` | `remote-kubernetes` | `remote-custom`). */
  engine: string
  /**
   * The environment-backend REGISTRY kind that builds this handler's provider (`manifest` |
   * `kubernetes` | `compose` | a custom kind). Distinct from {@link engine}: several backends
   * can serve the same engine (e.g. a custom backend riding `remote-custom`), so the engine
   * alone can't recover the exact provider — the registry is keyed by this kind.
   */
  backendKind: string
  providerId: string
  label: string
  baseUrl: string
  /**
   * The serialized handler config (an `InfraHandlerConfig` — the engine connection, sans
   * secrets), as JSON. A native engine (`local-k3s`/`remote-kubernetes`) carries only the
   * apiserver/sizing here; the manifests to apply come from the SERVICE at provision time
   * (the deployer merges the two). Renamed from the pre-reshape `manifestJson`.
   */
  handlerJson: string
  /** For a `remote-custom` engine: the custom manifest id this provider accepts; `null` otherwise. */
  acceptsManifestId: string | null
  /** Ciphertext of the `{ key: value }` secret bundle (SecretCipher envelope). */
  secretsCipher: string
  createdAt: number
  /** Set when the workspace unregisters this handler (tombstone). */
  deletedAt: number | null
}

export interface EnvironmentConnectionRepository {
  /** Every live handler the workspace has registered (batched — no per-type point reads). */
  listByWorkspace(workspaceId: string): Promise<EnvironmentConnectionRecord[]>
  /** The live handler for one provision type (+ custom manifest id), or null. */
  getByWorkspaceAndType(
    workspaceId: string,
    provisionType: string,
    manifestId: string | null,
  ): Promise<EnvironmentConnectionRecord | null>
  /** Create or replace one handler (keyed by workspace + provisionType + manifestId). */
  upsert(record: EnvironmentConnectionRecord): Promise<void>
  /** Tombstone one handler. */
  softDelete(
    workspaceId: string,
    provisionType: string,
    manifestId: string | null,
    at: number,
  ): Promise<void>
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
