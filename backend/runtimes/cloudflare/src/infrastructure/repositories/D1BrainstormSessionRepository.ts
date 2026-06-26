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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Brainstorm (structured-dialogue) sessions, stored one row per session in
 * `brainstorm_sessions`. The mirror of {@link D1ClarityReviewRepository}, but keyed by
 * (block, stage): the service keeps at most one live session per block+stage, so
 * `getByBlockStage` returns the latest for that stage.
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

  async upsert(workspaceId: string, session: BrainstormSession): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO brainstorm_sessions
           (workspace_id, id, block_id, stage, status, items, model, converged_direction,
            iteration, max_iterations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           stage = excluded.stage,
           status = excluded.status,
           items = excluded.items,
           model = excluded.model,
           converged_direction = excluded.converged_direction,
           iteration = excluded.iteration,
           max_iterations = excluded.max_iterations,
           updated_at = excluded.updated_at`,
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
      .run()
  }

  async deleteByBlockStage(
    workspaceId: string,
    blockId: string,
    stage: BrainstormStage,
  ): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM brainstorm_sessions WHERE workspace_id = ? AND block_id = ? AND stage = ?`,
      )
      .bind(workspaceId, blockId, stage)
      .run()
  }
}
