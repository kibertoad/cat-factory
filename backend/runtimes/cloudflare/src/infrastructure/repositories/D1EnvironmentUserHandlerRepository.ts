import type {
  EnvironmentUserHandlerRecord,
  EnvironmentUserHandlerRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// D1-backed store of a user's per-type infra handler overrides (local mode), keyed by
// (user_id, workspace_id, provision_type, manifest_id). `manifest_id` is '' for non-custom
// types so it sits in the composite PK cleanly; the record maps '' ⇄ null. Migration 0024.

interface EnvironmentUserHandlerRow {
  user_id: string
  workspace_id: string
  provision_type: string
  manifest_id: string
  engine: string
  provider_id: string
  label: string
  base_url: string
  handler_json: string
  accepts_manifest_id: string | null
  secrets_cipher: string
  created_at: number
  updated_at: number
}

function toRecord(row: EnvironmentUserHandlerRow): EnvironmentUserHandlerRecord {
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

export class D1EnvironmentUserHandlerRepository implements EnvironmentUserHandlerRepository {
  private readonly db: D1Database
  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByUserWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<EnvironmentUserHandlerRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM environment_user_handlers
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY created_at ASC`,
      )
      .bind(userId, workspaceId)
      .all<EnvironmentUserHandlerRow>()
    return (results ?? []).map(toRecord)
  }

  async upsert(record: EnvironmentUserHandlerRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO environment_user_handlers
           (user_id, workspace_id, provision_type, manifest_id, engine, provider_id, label,
            base_url, handler_json, accepts_manifest_id, secrets_cipher, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, workspace_id, provision_type, manifest_id) DO UPDATE SET
           engine = excluded.engine,
           provider_id = excluded.provider_id,
           label = excluded.label,
           base_url = excluded.base_url,
           handler_json = excluded.handler_json,
           accepts_manifest_id = excluded.accepts_manifest_id,
           secrets_cipher = excluded.secrets_cipher,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.userId,
        record.workspaceId,
        record.provisionType,
        record.manifestId ?? '',
        record.engine,
        record.providerId,
        record.label,
        record.baseUrl,
        record.handlerJson,
        record.acceptsManifestId,
        record.secretsCipher,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async remove(
    userId: string,
    workspaceId: string,
    provisionType: string,
    manifestId: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM environment_user_handlers
         WHERE user_id = ? AND workspace_id = ? AND provision_type = ? AND manifest_id = ?`,
      )
      .bind(userId, workspaceId, provisionType, manifestId ?? '')
      .run()
  }
}
