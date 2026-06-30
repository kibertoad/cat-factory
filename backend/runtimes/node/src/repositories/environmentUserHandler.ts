import type {
  EnvironmentUserHandlerRecord,
  EnvironmentUserHandlerRepository,
} from '@cat-factory/kernel'
import { and, asc, eq } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { environmentUserHandlers } from '../db/schema.js'

// Postgres mirror of D1EnvironmentUserHandlerRepository (migration 0024): a user's per-type
// infra handler overrides (local mode), keyed by (user_id, workspace_id, provision_type,
// manifest_id). `manifest_id` is '' for non-custom types; the record maps '' ⇄ null.

type Row = typeof environmentUserHandlers.$inferSelect

function toRecord(row: Row): EnvironmentUserHandlerRecord {
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    provisionType: row.provision_type,
    manifestId: row.manifest_id === '' ? null : row.manifest_id,
    engine: row.engine,
    providerId: row.provider_id,
    label: row.label,
    baseUrl: row.base_url,
    handlerJson: row.handler_json,
    acceptsManifestId: row.accepts_manifest_id,
    secretsCipher: row.secrets_cipher,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class DrizzleEnvironmentUserHandlerRepository implements EnvironmentUserHandlerRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByUserWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<EnvironmentUserHandlerRecord[]> {
    const rows = await this.db
      .select()
      .from(environmentUserHandlers)
      .where(
        and(
          eq(environmentUserHandlers.user_id, userId),
          eq(environmentUserHandlers.workspace_id, workspaceId),
        ),
      )
      .orderBy(asc(environmentUserHandlers.created_at))
    return rows.map(toRecord)
  }

  async upsert(record: EnvironmentUserHandlerRecord): Promise<void> {
    await this.db
      .insert(environmentUserHandlers)
      .values({
        user_id: record.userId,
        workspace_id: record.workspaceId,
        provision_type: record.provisionType,
        manifest_id: record.manifestId ?? '',
        engine: record.engine,
        provider_id: record.providerId,
        label: record.label,
        base_url: record.baseUrl,
        handler_json: record.handlerJson,
        accepts_manifest_id: record.acceptsManifestId,
        secrets_cipher: record.secretsCipher,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          environmentUserHandlers.user_id,
          environmentUserHandlers.workspace_id,
          environmentUserHandlers.provision_type,
          environmentUserHandlers.manifest_id,
        ],
        set: {
          engine: record.engine,
          provider_id: record.providerId,
          label: record.label,
          base_url: record.baseUrl,
          handler_json: record.handlerJson,
          accepts_manifest_id: record.acceptsManifestId,
          secrets_cipher: record.secretsCipher,
          updated_at: record.updatedAt,
        },
      })
  }

  async remove(
    userId: string,
    workspaceId: string,
    provisionType: string,
    manifestId: string | null,
  ): Promise<void> {
    await this.db
      .delete(environmentUserHandlers)
      .where(
        and(
          eq(environmentUserHandlers.user_id, userId),
          eq(environmentUserHandlers.workspace_id, workspaceId),
          eq(environmentUserHandlers.provision_type, provisionType),
          eq(environmentUserHandlers.manifest_id, manifestId ?? ''),
        ),
      )
  }
}
