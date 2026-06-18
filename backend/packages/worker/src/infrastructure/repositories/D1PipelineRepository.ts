import type { PipelineRepository } from '@cat-factory/kernel'
import type { Pipeline } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { type PipelineRow, rowToPipeline } from './mappers'

export class D1PipelineRepository implements PipelineRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByWorkspace(workspaceId: string): Promise<Pipeline[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM pipelines WHERE workspace_id = ? ORDER BY rowid')
      .bind(workspaceId)
      .all<PipelineRow>()
    return results.map(rowToPipeline)
  }

  async get(workspaceId: string, id: string): Promise<Pipeline | null> {
    const row = await this.db
      .prepare('SELECT * FROM pipelines WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<PipelineRow>()
    return row ? rowToPipeline(row) : null
  }

  async insert(workspaceId: string, pipeline: Pipeline): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO pipelines (workspace_id, id, name, agent_kinds, gates) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(
        workspaceId,
        pipeline.id,
        pipeline.name,
        JSON.stringify(pipeline.agentKinds),
        pipeline.gates ? JSON.stringify(pipeline.gates) : null,
      )
      .run()
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM pipelines WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .run()
  }
}
