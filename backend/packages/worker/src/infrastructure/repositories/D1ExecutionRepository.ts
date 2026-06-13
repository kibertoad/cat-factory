import type { ExecutionRepository } from '@cat-factory/core'
import type { ExecutionInstance } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { type ExecutionRow, rowToExecution } from './mappers'

export class D1ExecutionRepository implements ExecutionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
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
    await this.db
      .prepare(
        `INSERT INTO executions
           (workspace_id, id, block_id, pipeline_id, pipeline_name, steps, current_step, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           pipeline_id = excluded.pipeline_id,
           pipeline_name = excluded.pipeline_name,
           steps = excluded.steps,
           current_step = excluded.current_step,
           status = excluded.status`,
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
      )
      .run()
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM executions WHERE workspace_id = ? AND block_id = ?')
      .bind(workspaceId, blockId)
      .run()
  }
}
