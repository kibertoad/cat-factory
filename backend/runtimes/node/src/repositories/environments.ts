import type {
  EnvironmentConnectionRecord,
  EnvironmentConnectionRepository,
  EnvironmentRecord,
  EnvironmentRecordPatch,
  EnvironmentRegistryRepository,
} from '@cat-factory/kernel'
import { and, asc, desc, eq, isNotNull, isNull, lte } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { environmentConnections, environments } from '../db/schema.js'

// Drizzle/Postgres mirrors of the ephemeral-environment D1 repositories (migration
// 0025). All rows are workspace-scoped; credentials are opaque ciphertext (encrypted
// upstream by the SecretCipher). Behaviourally identical to the D1 repos so the
// cross-runtime conformance suite asserts the same behaviour against both stores.

type EnvironmentConnectionRow = typeof environmentConnections.$inferSelect

function rowToConnection(row: EnvironmentConnectionRow): EnvironmentConnectionRecord {
  return {
    workspaceId: row.workspace_id,
    provisionType: row.provision_type,
    manifestId: row.manifest_id === '' ? null : row.manifest_id,
    engine: row.engine,
    backendKind: row.backend_kind,
    providerId: row.provider_id,
    label: row.label,
    baseUrl: row.base_url,
    handlerJson: row.handler_json,
    acceptsManifestId: row.accepts_manifest_id,
    secretsCipher: row.secrets_cipher,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

/** Workspace → per-type environment handler bindings over Postgres (migration 0025). */
export class DrizzleEnvironmentConnectionRepository implements EnvironmentConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByWorkspace(workspaceId: string): Promise<EnvironmentConnectionRecord[]> {
    const rows = await this.db
      .select()
      .from(environmentConnections)
      .where(
        and(
          eq(environmentConnections.workspace_id, workspaceId),
          isNull(environmentConnections.deleted_at),
        ),
      )
      .orderBy(asc(environmentConnections.created_at))
    return rows.map(rowToConnection)
  }

  async getByWorkspaceAndType(
    workspaceId: string,
    provisionType: string,
    manifestId: string | null,
  ): Promise<EnvironmentConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(environmentConnections)
      .where(
        and(
          eq(environmentConnections.workspace_id, workspaceId),
          eq(environmentConnections.provision_type, provisionType),
          eq(environmentConnections.manifest_id, manifestId ?? ''),
          isNull(environmentConnections.deleted_at),
        ),
      )
      .limit(1)
    return rows[0] ? rowToConnection(rows[0]) : null
  }

  async upsert(record: EnvironmentConnectionRecord): Promise<void> {
    // Clear any prior row (live or tombstoned) on the same composite key first, so a
    // re-register that changes the engine/provider can't collide on the primary key.
    // Delete + insert run in one transaction so a concurrent reader never sees the
    // binding transiently absent.
    await this.db.transaction(async (tx) => {
      await tx
        .delete(environmentConnections)
        .where(
          and(
            eq(environmentConnections.workspace_id, record.workspaceId),
            eq(environmentConnections.provision_type, record.provisionType),
            eq(environmentConnections.manifest_id, record.manifestId ?? ''),
          ),
        )
      await tx.insert(environmentConnections).values({
        workspace_id: record.workspaceId,
        provision_type: record.provisionType,
        manifest_id: record.manifestId ?? '',
        engine: record.engine,
        backend_kind: record.backendKind,
        provider_id: record.providerId,
        label: record.label,
        base_url: record.baseUrl,
        handler_json: record.handlerJson,
        accepts_manifest_id: record.acceptsManifestId,
        secrets_cipher: record.secretsCipher,
        created_at: record.createdAt,
        deleted_at: null,
      })
    })
  }

  async softDelete(
    workspaceId: string,
    provisionType: string,
    manifestId: string | null,
    at: number,
  ): Promise<void> {
    await this.db
      .update(environmentConnections)
      .set({ deleted_at: at })
      .where(
        and(
          eq(environmentConnections.workspace_id, workspaceId),
          eq(environmentConnections.provision_type, provisionType),
          eq(environmentConnections.manifest_id, manifestId ?? ''),
          isNull(environmentConnections.deleted_at),
        ),
      )
  }
}

type EnvironmentRow = typeof environments.$inferSelect

function rowToEnvironment(row: EnvironmentRow): EnvironmentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    frameId: row.frame_id ?? null,
    executionId: row.execution_id,
    providerId: row.provider_id,
    externalId: row.external_id,
    url: row.url,
    status: row.status as EnvironmentRecord['status'],
    accessCipher: row.access_cipher,
    provisionFieldsCipher: row.provision_fields_cipher,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastError: row.last_error,
    deletedAt: row.deleted_at,
    provisionType: row.provision_type ?? null,
    engine: row.engine ?? null,
  }
}

/** Maps a patch field name to its Drizzle column. */
const PATCH_COLUMNS = {
  externalId: 'external_id',
  url: 'url',
  status: 'status',
  accessCipher: 'access_cipher',
  provisionFieldsCipher: 'provision_fields_cipher',
  expiresAt: 'expires_at',
  lastError: 'last_error',
  provisionType: 'provision_type',
  engine: 'engine',
} as const satisfies Record<keyof EnvironmentRecordPatch, string>

/** Registry of provisioned environments over Postgres (migration 0008). */
export class DrizzleEnvironmentRegistryRepository implements EnvironmentRegistryRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(record: EnvironmentRecord): Promise<void> {
    await this.db.insert(environments).values({
      id: record.id,
      workspace_id: record.workspaceId,
      block_id: record.blockId,
      frame_id: record.frameId,
      execution_id: record.executionId,
      provider_id: record.providerId,
      external_id: record.externalId,
      url: record.url,
      status: record.status,
      access_cipher: record.accessCipher,
      provision_fields_cipher: record.provisionFieldsCipher,
      created_at: record.createdAt,
      expires_at: record.expiresAt,
      last_error: record.lastError,
      deleted_at: null,
      provision_type: record.provisionType,
      engine: record.engine,
    })
  }

  async update(workspaceId: string, id: string, patch: EnvironmentRecordPatch): Promise<void> {
    const set: Record<string, string | number | null> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      set[PATCH_COLUMNS[key as keyof EnvironmentRecordPatch]] = value as string | number | null
    }
    if (Object.keys(set).length === 0) return
    await this.db
      .update(environments)
      .set(set)
      .where(
        and(
          eq(environments.workspace_id, workspaceId),
          eq(environments.id, id),
          isNull(environments.deleted_at),
        ),
      )
  }

  async get(workspaceId: string, id: string): Promise<EnvironmentRecord | null> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.workspace_id, workspaceId),
          eq(environments.id, id),
          isNull(environments.deleted_at),
        ),
      )
      .limit(1)
    return rows[0] ? rowToEnvironment(rows[0]) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<EnvironmentRecord | null> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.workspace_id, workspaceId),
          eq(environments.block_id, blockId),
          isNull(environments.deleted_at),
        ),
      )
      .orderBy(desc(environments.created_at))
      .limit(1)
    return rows[0] ? rowToEnvironment(rows[0]) : null
  }

  async getByBlockAndFrame(
    workspaceId: string,
    blockId: string,
    frameId: string,
  ): Promise<EnvironmentRecord | null> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.workspace_id, workspaceId),
          eq(environments.block_id, blockId),
          eq(environments.frame_id, frameId),
          isNull(environments.deleted_at),
        ),
      )
      .orderBy(desc(environments.created_at))
      .limit(1)
    return rows[0] ? rowToEnvironment(rows[0]) : null
  }

  async getFramelessByBlock(
    workspaceId: string,
    blockId: string,
  ): Promise<EnvironmentRecord | null> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.workspace_id, workspaceId),
          eq(environments.block_id, blockId),
          isNull(environments.frame_id),
          isNull(environments.deleted_at),
        ),
      )
      .orderBy(desc(environments.created_at))
      .limit(1)
    return rows[0] ? rowToEnvironment(rows[0]) : null
  }

  async listByWorkspace(workspaceId: string): Promise<EnvironmentRecord[]> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(and(eq(environments.workspace_id, workspaceId), isNull(environments.deleted_at)))
      .orderBy(desc(environments.created_at))
    return rows.map(rowToEnvironment)
  }

  async listExpired(nowEpochMs: number): Promise<EnvironmentRecord[]> {
    const rows = await this.db
      .select()
      .from(environments)
      .where(
        and(
          isNull(environments.deleted_at),
          isNotNull(environments.expires_at),
          lte(environments.expires_at, nowEpochMs),
        ),
      )
    return rows.map(rowToEnvironment)
  }

  async softDelete(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .update(environments)
      .set({ deleted_at: at })
      .where(
        and(
          eq(environments.workspace_id, workspaceId),
          eq(environments.id, id),
          isNull(environments.deleted_at),
        ),
      )
  }
}
