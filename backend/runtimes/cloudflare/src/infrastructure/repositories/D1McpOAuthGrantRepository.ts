import type { McpOAuthGrantRecord, McpOAuthGrantRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface McpOAuthGrantRow {
  workspace_id: string
  server_id: string
  tokens: string
  summary: string
  rev: number
  created_at: number
  updated_at: number
}

function rowToRecord(row: McpOAuthGrantRow): McpOAuthGrantRecord {
  return {
    workspaceId: row.workspace_id,
    serverId: row.server_id,
    tokens: row.tokens,
    summary: row.summary,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A workspace's OAuth grants against remote MCP tool servers (migration 0082), one row per
 * (workspace, server). `tokens` is a sealed envelope the service opens; `summary` is the non-secret
 * blob the connection panel renders.
 *
 * The rev-guarded `compareAndSwap` is what the REFRESH path rides (an `UPDATE … WHERE rev = ?`
 * whose changed-row count decides the winner); the blind `upsert` bumps the stored rev in SQL, so a
 * human completing a grant reliably beats a concurrent refresh's stale base. The Drizzle mirror is
 * `DrizzleMcpOAuthGrantRepository`.
 */
export class D1McpOAuthGrantRepository implements McpOAuthGrantRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, serverId: string): Promise<McpOAuthGrantRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM mcp_oauth_grants WHERE workspace_id = ? AND server_id = ?`)
      .bind(workspaceId, serverId)
      .first<McpOAuthGrantRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<McpOAuthGrantRecord[]> {
    const result = await this.db
      .prepare(`SELECT * FROM mcp_oauth_grants WHERE workspace_id = ? ORDER BY server_id`)
      .bind(workspaceId)
      .all<McpOAuthGrantRow>()
    return (result.results ?? []).map(rowToRecord)
  }

  async upsert(record: McpOAuthGrantRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO mcp_oauth_grants (workspace_id, server_id, tokens, summary, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, server_id) DO UPDATE SET
           tokens = excluded.tokens,
           summary = excluded.summary,
           rev = mcp_oauth_grants.rev + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.serverId,
        record.tokens,
        record.summary,
        record.rev,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async compareAndSwap(record: McpOAuthGrantRecord, expectedRev: number | null): Promise<boolean> {
    if (expectedRev === null) {
      const result = await this.db
        .prepare(
          `INSERT INTO mcp_oauth_grants (workspace_id, server_id, tokens, summary, rev, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, server_id) DO NOTHING`,
        )
        .bind(
          record.workspaceId,
          record.serverId,
          record.tokens,
          record.summary,
          record.rev,
          record.createdAt,
          record.updatedAt,
        )
        .run()
      return (result.meta?.changes ?? 0) > 0
    }
    const result = await this.db
      .prepare(
        `UPDATE mcp_oauth_grants
           SET tokens = ?, summary = ?, rev = ?, updated_at = ?
         WHERE workspace_id = ? AND server_id = ? AND rev = ?`,
      )
      .bind(
        record.tokens,
        record.summary,
        record.rev,
        record.updatedAt,
        record.workspaceId,
        record.serverId,
        expectedRev,
      )
      .run()
    return (result.meta?.changes ?? 0) > 0
  }

  async delete(workspaceId: string, serverId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM mcp_oauth_grants WHERE workspace_id = ? AND server_id = ?`)
      .bind(workspaceId, serverId)
      .run()
  }
}
