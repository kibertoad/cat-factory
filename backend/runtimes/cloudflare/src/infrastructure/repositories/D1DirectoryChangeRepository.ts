import type { DirectoryChangeRecord, DirectoryChangeRepository } from '@cat-factory/kernel'
import { isDirectoryEntityType } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface DirectoryChangeRow {
  account_id: string
  seq: number
  entity_type: string
  workspace_id: string | null
  entity_id: string
  at: number
}

function rowToChange(row: DirectoryChangeRow): DirectoryChangeRecord {
  // The vocabulary is append-only, so an unknown value is a row this build cannot interpret, not
  // one to skip: a reader that dropped it would advance its cursor past a change it never served.
  if (!isDirectoryEntityType(row.entity_type)) {
    throw new Error(`Unknown directory entity type '${row.entity_type}' at seq ${row.seq}`)
  }
  return {
    accountId: row.account_id,
    seq: row.seq,
    entityType: row.entity_type,
    workspaceId: row.workspace_id,
    entityId: row.entity_id,
    at: row.at,
  }
}

/** D1-backed read side of the directory change feed (migration 0107). */
export class D1DirectoryChangeRepository implements DirectoryChangeRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listAfter(
    accountId: string,
    afterSeq: number,
    limit: number,
  ): Promise<DirectoryChangeRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM directory_changes WHERE account_id = ? AND seq > ?
          ORDER BY seq ASC LIMIT ?`,
      )
      .bind(accountId, afterSeq, limit)
      .all<DirectoryChangeRow>()
    return results.map(rowToChange)
  }

  async headSeq(accountId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT MAX(seq) AS head FROM directory_changes WHERE account_id = ?')
      .bind(accountId)
      .first<{ head: number | null }>()
    return row?.head ?? 0
  }
}
