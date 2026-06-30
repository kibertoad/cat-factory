import type {
  EnvironmentConnectionRecord,
  EnvironmentConnectionRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// D1-backed store of a workspace's per-provision-type infra handlers (migration 0025), keyed
// by (workspace_id, provision_type, manifest_id). `manifest_id` is '' for the non-custom
// types so it sits in the composite PK cleanly; the record maps '' ⇄ null. `handler_json`
// carries the engine connection (sans secrets). See docs/initiatives/per-service-provision-types.md.

interface EnvironmentConnectionRow {
  workspace_id: string
  provision_type: string
  manifest_id: string
  engine: string
  backend_kind: string
  provider_id: string
  label: string
  base_url: string
  handler_json: string
  accepts_manifest_id: string | null
  secrets_cipher: string
  created_at: number
  deleted_at: number | null
}

function rowToRecord(row: EnvironmentConnectionRow): EnvironmentConnectionRecord {
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

/** D1-backed store of workspace → per-type environment handler bindings (migration 0025). */
export class D1EnvironmentConnectionRepository implements EnvironmentConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByWorkspace(workspaceId: string): Promise<EnvironmentConnectionRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM environment_connections
         WHERE workspace_id = ? AND deleted_at IS NULL
         ORDER BY created_at ASC`,
      )
      .bind(workspaceId)
      .all<EnvironmentConnectionRow>()
    return (results ?? []).map(rowToRecord)
  }

  async getByWorkspaceAndType(
    workspaceId: string,
    provisionType: string,
    manifestId: string | null,
  ): Promise<EnvironmentConnectionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM environment_connections
         WHERE workspace_id = ? AND provision_type = ? AND manifest_id = ? AND deleted_at IS NULL`,
      )
      .bind(workspaceId, provisionType, manifestId ?? '')
      .first<EnvironmentConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: EnvironmentConnectionRecord): Promise<void> {
    // Clear any prior row (live or tombstoned) on the same composite key first, so a
    // re-register that changes the engine/provider can't collide on the primary key.
    await this.db
      .prepare(
        `DELETE FROM environment_connections
         WHERE workspace_id = ? AND provision_type = ? AND manifest_id = ?`,
      )
      .bind(record.workspaceId, record.provisionType, record.manifestId ?? '')
      .run()
    await this.db
      .prepare(
        `INSERT INTO environment_connections
          (workspace_id, provision_type, manifest_id, engine, backend_kind, provider_id, label, base_url,
           handler_json, accepts_manifest_id, secrets_cipher, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        record.workspaceId,
        record.provisionType,
        record.manifestId ?? '',
        record.engine,
        record.backendKind,
        record.providerId,
        record.label,
        record.baseUrl,
        record.handlerJson,
        record.acceptsManifestId,
        record.secretsCipher,
        record.createdAt,
      )
      .run()
  }

  async softDelete(
    workspaceId: string,
    provisionType: string,
    manifestId: string | null,
    at: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE environment_connections SET deleted_at = ?
         WHERE workspace_id = ? AND provision_type = ? AND manifest_id = ? AND deleted_at IS NULL`,
      )
      .bind(at, workspaceId, provisionType, manifestId ?? '')
      .run()
  }
}
