import type { DocInterviewRepository } from '@cat-factory/kernel'
import type { DocInterviewQa, DocInterviewSession } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface DocInterviewRow {
  id: string
  block_id: string
  status: string
  round: number
  max_rounds: number
  qa: string
  brief: string | null
  model: string | null
  created_at: number
  updated_at: number
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function rowToSession(row: DocInterviewRow): DocInterviewSession {
  return {
    id: row.id,
    blockId: row.block_id,
    status: row.status as DocInterviewSession['status'],
    round: row.round,
    maxRounds: row.max_rounds,
    qa: parseJsonArray<DocInterviewQa>(row.qa),
    brief: row.brief,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Interactive document-interview sessions (WS5), stored one row per session in
 * `doc_interview_sessions` (migration 0040). The Q&A live as a JSON array in `qa`; the service
 * keeps at most one live session per block, so `getByBlock` returns the latest by `created_at`.
 */
export class D1DocInterviewRepository implements DocInterviewRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<DocInterviewSession | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM doc_interview_sessions
           WHERE workspace_id = ? AND block_id = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, blockId)
      .first<DocInterviewRow>()
    return row ? rowToSession(row) : null
  }

  async get(workspaceId: string, id: string): Promise<DocInterviewSession | null> {
    const row = await this.db
      .prepare(`SELECT * FROM doc_interview_sessions WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<DocInterviewRow>()
    return row ? rowToSession(row) : null
  }

  async upsert(workspaceId: string, session: DocInterviewSession): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO doc_interview_sessions
           (workspace_id, id, block_id, status, round, max_rounds, qa, brief, model,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           status = excluded.status,
           round = excluded.round,
           max_rounds = excluded.max_rounds,
           qa = excluded.qa,
           brief = excluded.brief,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .bind(
        workspaceId,
        session.id,
        session.blockId,
        session.status,
        session.round,
        session.maxRounds,
        JSON.stringify(session.qa ?? []),
        session.brief,
        session.model,
        session.createdAt,
        session.updatedAt,
      )
      .run()
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM doc_interview_sessions WHERE workspace_id = ? AND block_id = ?`)
      .bind(workspaceId, blockId)
      .run()
  }
}
