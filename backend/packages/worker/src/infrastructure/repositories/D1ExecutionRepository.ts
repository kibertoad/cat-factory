import type { Clock, ExecutionRepository, RunRef } from '@cat-factory/core'
import type { ExecutionInstance } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { type ExecutionRow, rowToExecution } from './mappers'

export class D1ExecutionRepository implements ExecutionRepository {
  private readonly db: D1Database
  private readonly clock: Clock

  constructor({ db, clock }: { db: D1Database; clock: Clock }) {
    this.db = db
    this.clock = clock
  }

  async listByWorkspace(workspaceId: string): Promise<ExecutionInstance[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM executions WHERE workspace_id = ? ORDER BY rowid')
      .bind(workspaceId)
      .all<ExecutionRow>()
    return results.map(rowToExecution)
  }

  async get(workspaceId: string, id: string): Promise<ExecutionInstance | null> {
    const row = await this.db
      .prepare('SELECT * FROM executions WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<ExecutionRow>()
    return row ? rowToExecution(row) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<ExecutionInstance | null> {
    const row = await this.db
      .prepare('SELECT * FROM executions WHERE workspace_id = ? AND block_id = ?')
      .bind(workspaceId, blockId)
      .first<ExecutionRow>()
    return row ? rowToExecution(row) : null
  }

  async upsert(workspaceId: string, execution: ExecutionInstance): Promise<void> {
    // `updated_at` is refreshed on every write so it doubles as the sweeper's
    // lease. `error`/`workflow_instance_id` are deliberately left out of the
    // conflict update so they survive normal step writes (see markError).
    await this.db
      .prepare(
        `INSERT INTO executions
           (workspace_id, id, block_id, pipeline_id, pipeline_name, steps, current_step,
            status, updated_at, workflow_instance_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           pipeline_id = excluded.pipeline_id,
           pipeline_name = excluded.pipeline_name,
           steps = excluded.steps,
           current_step = excluded.current_step,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .bind(
        workspaceId,
        execution.id,
        execution.blockId,
        execution.pipelineId,
        execution.pipelineName,
        JSON.stringify(execution.steps),
        execution.currentStep,
        execution.status,
        this.clock.now(),
        // Instance id == execution id today; stored for forward-compatibility.
        execution.id,
      )
      .run()
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM executions WHERE workspace_id = ? AND block_id = ?')
      .bind(workspaceId, blockId)
      .run()
  }

  async listStale(olderThanEpochMs: number): Promise<RunRef[]> {
    const { results } = await this.db
      .prepare(
        `SELECT workspace_id, id FROM executions
         WHERE status = 'running' AND updated_at < ?
         ORDER BY updated_at`,
      )
      .bind(olderThanEpochMs)
      .all<{ workspace_id: string; id: string }>()
    return results.map((r) => ({ workspaceId: r.workspace_id, id: r.id }))
  }

  async markError(workspaceId: string, id: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE executions
           SET status = 'done', error = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .bind(error, this.clock.now(), workspaceId, id)
      .run()
  }
}
