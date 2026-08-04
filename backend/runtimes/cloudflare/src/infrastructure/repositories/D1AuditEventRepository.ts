import type { AuditEventPage, AuditEventRecord, AuditEventRepository } from '@cat-factory/kernel'
import {
  auditActorColumns,
  auditPageLimit,
  decodeAuditCursor,
  encodeAuditCursor,
  rowToAuditActor,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface AuditEventRow {
  id: string
  account_id: string
  workspace_id: string | null
  actor_kind: string
  actor_user_id: string | null
  actor_api_key_id: string | null
  action: string
  target_type: string
  target_id: string
  summary: string
  at: number
}

function toRecord(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    actor: rowToAuditActor(row),
    action: row.action as AuditEventRecord['action'],
    targetType: row.target_type,
    targetId: row.target_id,
    summary: row.summary,
    at: row.at,
  }
}

/** D1 append-only account audit log. Mirror of the Drizzle repo. */
export class D1AuditEventRepository implements AuditEventRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async append(event: AuditEventRecord): Promise<void> {
    const actor = auditActorColumns(event.actor)
    // No conflict clause: an id collision is an id-generator bug, and quietly folding one append
    // onto another would lose an audited action, the one outcome this table exists to prevent.
    await this.db
      .prepare(
        `INSERT INTO audit_events
           (id, account_id, workspace_id, actor_kind, actor_user_id, actor_api_key_id,
            action, target_type, target_id, summary, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.accountId,
        event.workspaceId ?? null,
        actor.actor_kind,
        actor.actor_user_id,
        actor.actor_api_key_id,
        event.action,
        event.targetType,
        event.targetId,
        event.summary,
        event.at,
      )
      .run()
  }

  async listByAccount(
    accountId: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<AuditEventPage> {
    const limit = auditPageLimit(options?.limit)
    const after = decodeAuditCursor(options?.cursor)
    // One extra row tells us whether another page exists, with no second COUNT query. The keyset
    // predicate is the (at, id) pair, matching the index's ordering exactly: an OFFSET would
    // re-read every earlier row and skip a row that arrived mid-pagination.
    const statement = after
      ? this.db
          .prepare(
            `SELECT * FROM audit_events
              WHERE account_id = ? AND (at < ? OR (at = ? AND id < ?))
              ORDER BY at DESC, id DESC LIMIT ?`,
          )
          .bind(accountId, after.at, after.at, after.id, limit + 1)
      : this.db
          .prepare(
            `SELECT * FROM audit_events
              WHERE account_id = ?
              ORDER BY at DESC, id DESC LIMIT ?`,
          )
          .bind(accountId, limit + 1)

    const result = await statement.all<AuditEventRow>()
    const rows = result.results ?? []
    const page = rows.slice(0, limit).map(toRecord)
    const last = page.at(-1)
    return {
      events: page,
      nextCursor: rows.length > limit && last ? encodeAuditCursor(last) : null,
    }
  }
}
