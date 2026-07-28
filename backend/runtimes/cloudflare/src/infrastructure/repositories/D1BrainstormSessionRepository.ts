import type { BrainstormSessionRepository } from '@cat-factory/kernel'
import type { BrainstormItem, BrainstormSession, BrainstormStage } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface BrainstormSessionRow {
  id: string
  block_id: string
  stage: string
  status: string
  items: string
  model: string | null
  converged_direction: string | null
  iteration: number
  max_iterations: number
  rev: number | null
  created_at: number
  updated_at: number
}

function rowToSession(row: BrainstormSessionRow): BrainstormSession {
  let items: BrainstormItem[] = []
  try {
    const parsed = JSON.parse(row.items)
    if (Array.isArray(parsed)) items = parsed as BrainstormItem[]
  } catch {
    items = []
  }
  return {
    id: row.id,
    blockId: row.block_id,
    stage: row.stage as BrainstormStage,
    status: row.status as BrainstormSession['status'],
    items,
    model: row.model,
    convergedDirection: row.converged_direction,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    rev: row.rev ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Brainstorm (structured-dialogue) sessions, stored one row per session in
 * `brainstorm_sessions`. The mirror of {@link D1ClarityReviewRepository} — same rev-guarded
 * `compareAndSwap` contract — but keyed by (block, stage): `replaceForBlockStage` keeps one live
 * session per block+stage, so `getByBlockStage` returns it and the block's other stage is never
 * disturbed.
 */
export class D1BrainstormSessionRepository implements BrainstormSessionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByBlockStage(
    workspaceId: string,
    blockId: string,
    stage: BrainstormStage,
  ): Promise<BrainstormSession | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM brainstorm_sessions
           WHERE workspace_id = ? AND block_id = ? AND stage = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, blockId, stage)
      .first<BrainstormSessionRow>()
    return row ? rowToSession(row) : null
  }

  async get(workspaceId: string, id: string): Promise<BrainstormSession | null> {
    const row = await this.db
      .prepare(`SELECT * FROM brainstorm_sessions WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<BrainstormSessionRow>()
    return row ? rowToSession(row) : null
  }

  private insertStatement(workspaceId: string, session: BrainstormSession) {
    // A fresh insert starts at rev 0; a force-write over an existing row BUMPS it, so a
    // concurrent compareAndSwap holding the old revision still detects that the row moved.
    return this.db
      .prepare(
        `INSERT INTO brainstorm_sessions
           (workspace_id, id, block_id, stage, status, items, model, converged_direction,
            iteration, max_iterations, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           stage = excluded.stage,
           status = excluded.status,
           items = excluded.items,
           model = excluded.model,
           converged_direction = excluded.converged_direction,
           iteration = excluded.iteration,
           max_iterations = excluded.max_iterations,
           rev = brainstorm_sessions.rev + 1,
           updated_at = excluded.updated_at
         RETURNING rev`,
      )
      .bind(
        workspaceId,
        session.id,
        session.blockId,
        session.stage,
        session.status,
        JSON.stringify(session.items),
        session.model,
        session.convergedDirection,
        session.iteration ?? 1,
        session.maxIterations ?? 1,
        session.createdAt,
        session.updatedAt,
      )
  }

  async upsert(workspaceId: string, session: BrainstormSession): Promise<void> {
    const row = await this.insertStatement(workspaceId, session).first<{ rev: number }>()
    if (row) session.rev = row.rev
  }

  async compareAndSwap(workspaceId: string, session: BrainstormSession): Promise<boolean> {
    // Conditional update guarded on the rev last read onto this session; writes only while the
    // stored row is unchanged, and never inserts (a deleted session must stay deleted).
    const row = await this.db
      .prepare(
        `UPDATE brainstorm_sessions SET
           block_id = ?,
           stage = ?,
           status = ?,
           items = ?,
           model = ?,
           converged_direction = ?,
           iteration = ?,
           max_iterations = ?,
           updated_at = ?,
           rev = rev + 1
         WHERE workspace_id = ? AND id = ? AND rev = ?
         RETURNING rev`,
      )
      .bind(
        session.blockId,
        session.stage,
        session.status,
        JSON.stringify(session.items),
        session.model,
        session.convergedDirection,
        session.iteration ?? 1,
        session.maxIterations ?? 1,
        session.updatedAt,
        workspaceId,
        session.id,
        session.rev ?? 0,
      )
      .first<{ rev: number }>()
    if (!row) return false
    session.rev = row.rev
    return true
  }

  async replaceForBlockStage(workspaceId: string, session: BrainstormSession): Promise<void> {
    // ONE transaction: `db.batch` so a second dialogue run for the same block+stage can't
    // interleave its delete between this delete and this insert and leave two live sessions
    // behind. Scoped to the session's OWN stage, so the block's other stage is untouched.
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM brainstorm_sessions WHERE workspace_id = ? AND block_id = ? AND stage = ?`,
        )
        .bind(workspaceId, session.blockId, session.stage),
      this.insertStatement(workspaceId, session),
    ])
    session.rev = 0
  }
}
