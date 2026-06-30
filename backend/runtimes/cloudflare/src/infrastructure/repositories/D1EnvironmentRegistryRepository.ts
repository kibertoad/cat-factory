import type {
  EnvironmentRecord,
  EnvironmentRecordPatch,
  EnvironmentRegistryRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface EnvironmentRow {
  id: string
  workspace_id: string
  block_id: string | null
  execution_id: string | null
  provider_id: string
  external_id: string | null
  url: string | null
  status: string
  access_cipher: string | null
  provision_fields_cipher: string | null
  created_at: number
  expires_at: number | null
  last_error: string | null
  deleted_at: number | null
  provision_type: string | null
  engine: string | null
}

function rowToRecord(row: EnvironmentRow): EnvironmentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    blockId: row.block_id,
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

/** Maps a patch field name to its DB column. */
const PATCH_COLUMNS: Record<keyof EnvironmentRecordPatch, string> = {
  externalId: 'external_id',
  url: 'url',
  status: 'status',
  accessCipher: 'access_cipher',
  provisionFieldsCipher: 'provision_fields_cipher',
  expiresAt: 'expires_at',
  lastError: 'last_error',
  provisionType: 'provision_type',
  engine: 'engine',
}

/** D1-backed registry of provisioned environments (migration 0008). */
export class D1EnvironmentRegistryRepository implements EnvironmentRegistryRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async insert(record: EnvironmentRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO environments
          (id, workspace_id, block_id, execution_id, provider_id, external_id, url, status,
           access_cipher, provision_fields_cipher, created_at, expires_at, last_error, deleted_at,
           provision_type, engine)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.blockId,
        record.executionId,
        record.providerId,
        record.externalId,
        record.url,
        record.status,
        record.accessCipher,
        record.provisionFieldsCipher,
        record.createdAt,
        record.expiresAt,
        record.lastError,
        record.provisionType,
        record.engine,
      )
      .run()
  }

  async update(workspaceId: string, id: string, patch: EnvironmentRecordPatch): Promise<void> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const setClause = entries
      .map(([key]) => `${PATCH_COLUMNS[key as keyof EnvironmentRecordPatch]} = ?`)
      .join(', ')
    const values = entries.map(([, value]) => value as string | number | null)
    await this.db
      .prepare(
        `UPDATE environments SET ${setClause} WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .bind(...values, workspaceId, id)
      .run()
  }

  async get(workspaceId: string, id: string): Promise<EnvironmentRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM environments WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId, id)
      .first<EnvironmentRow>()
    return row ? rowToRecord(row) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<EnvironmentRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM environments
         WHERE workspace_id = ? AND block_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, blockId)
      .first<EnvironmentRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<EnvironmentRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM environments WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      )
      .bind(workspaceId)
      .all<EnvironmentRow>()
    return (results ?? []).map(rowToRecord)
  }

  async listExpired(nowEpochMs: number): Promise<EnvironmentRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM environments
         WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .bind(nowEpochMs)
      .all<EnvironmentRow>()
    return (results ?? []).map(rowToRecord)
  }

  async softDelete(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE environments SET deleted_at = ? WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL',
      )
      .bind(at, workspaceId, id)
      .run()
  }
}
