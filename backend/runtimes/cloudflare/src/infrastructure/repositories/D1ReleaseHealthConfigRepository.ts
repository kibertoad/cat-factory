import type { ReleaseHealthConfigRecord, ReleaseHealthConfigRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ReleaseHealthConfigRow {
  workspace_id: string
  block_id: string
  monitor_ids: string
  slo_ids: string
  env_tag: string | null
  created_at: number
  updated_at: number
}

function parseIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
  } catch {
    return []
  }
}

function rowToRecord(row: ReleaseHealthConfigRow): ReleaseHealthConfigRecord {
  return {
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    monitorIds: parseIds(row.monitor_ids),
    sloIds: parseIds(row.slo_ids),
    envTag: row.env_tag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Per-block (service frame) monitor/SLO mapping for the post-release-health gate
 * (migration 0003). `monitor_ids`/`slo_ids` are JSON arrays as text.
 */
export class D1ReleaseHealthConfigRepository implements ReleaseHealthConfigRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByBlock(
    workspaceId: string,
    blockId: string,
  ): Promise<ReleaseHealthConfigRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM release_health_configs WHERE workspace_id = ? AND block_id = ?`)
      .bind(workspaceId, blockId)
      .first<ReleaseHealthConfigRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<ReleaseHealthConfigRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM release_health_configs WHERE workspace_id = ? ORDER BY block_id ASC`)
      .bind(workspaceId)
      .all<ReleaseHealthConfigRow>()
    return results.map(rowToRecord)
  }

  async upsert(record: ReleaseHealthConfigRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO release_health_configs
           (workspace_id, block_id, monitor_ids, slo_ids, env_tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, block_id) DO UPDATE SET
           monitor_ids = excluded.monitor_ids,
           slo_ids = excluded.slo_ids,
           env_tag = excluded.env_tag,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.blockId,
        JSON.stringify(record.monitorIds),
        JSON.stringify(record.sloIds),
        record.envTag,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async delete(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM release_health_configs WHERE workspace_id = ? AND block_id = ?`)
      .bind(workspaceId, blockId)
      .run()
  }
}
