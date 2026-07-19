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
    // Order by rowid: SQLite's monotonic insert sequence, so a workspace's pipelines
    // come back in the deterministic order they were seeded (the curated
    // `seedPipelines()` catalog order). The Postgres facade reproduces this with an
    // explicit `seq` column (it has no rowid) — see DrizzlePipelineRepository.
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
        'INSERT INTO pipelines (workspace_id, id, name, description, agent_kinds, gates, thresholds, enabled, consensus, gating, follow_ups, tester_quality, step_options, labels, archived, builtin, version, public, availability) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        workspaceId,
        pipeline.id,
        pipeline.name,
        pipeline.description ?? null,
        JSON.stringify(pipeline.agentKinds),
        pipeline.gates ? JSON.stringify(pipeline.gates) : null,
        pipeline.thresholds ? JSON.stringify(pipeline.thresholds) : null,
        pipeline.enabled ? JSON.stringify(pipeline.enabled) : null,
        pipeline.consensus ? JSON.stringify(pipeline.consensus) : null,
        pipeline.gating ? JSON.stringify(pipeline.gating) : null,
        pipeline.followUps ? JSON.stringify(pipeline.followUps) : null,
        pipeline.testerQuality ? JSON.stringify(pipeline.testerQuality) : null,
        pipeline.stepOptions ? JSON.stringify(pipeline.stepOptions) : null,
        pipeline.labels ? JSON.stringify(pipeline.labels) : null,
        pipeline.archived ? 1 : null,
        pipeline.builtin ? 1 : null,
        pipeline.version ?? null,
        pipeline.public ? 1 : null,
        pipeline.availability ?? null,
      )
      .run()
  }

  async update(workspaceId: string, pipeline: Pipeline): Promise<void> {
    // UPDATE (not delete+insert) preserves the row's rowid, so an edited pipeline keeps
    // its place in the catalog order. `builtin` is immutable, so it is not rewritten.
    // `version` IS rewritten so a reseed bumps the stored copy to the current catalog version.
    await this.db
      .prepare(
        'UPDATE pipelines SET name = ?, description = ?, agent_kinds = ?, gates = ?, thresholds = ?, enabled = ?, consensus = ?, gating = ?, follow_ups = ?, tester_quality = ?, step_options = ?, labels = ?, archived = ?, version = ?, public = ?, availability = ? WHERE workspace_id = ? AND id = ?',
      )
      .bind(
        pipeline.name,
        pipeline.description ?? null,
        JSON.stringify(pipeline.agentKinds),
        pipeline.gates ? JSON.stringify(pipeline.gates) : null,
        pipeline.thresholds ? JSON.stringify(pipeline.thresholds) : null,
        pipeline.enabled ? JSON.stringify(pipeline.enabled) : null,
        pipeline.consensus ? JSON.stringify(pipeline.consensus) : null,
        pipeline.gating ? JSON.stringify(pipeline.gating) : null,
        pipeline.followUps ? JSON.stringify(pipeline.followUps) : null,
        pipeline.testerQuality ? JSON.stringify(pipeline.testerQuality) : null,
        pipeline.stepOptions ? JSON.stringify(pipeline.stepOptions) : null,
        pipeline.labels ? JSON.stringify(pipeline.labels) : null,
        pipeline.archived ? 1 : null,
        pipeline.version ?? null,
        pipeline.public ? 1 : null,
        pipeline.availability ?? null,
        workspaceId,
        pipeline.id,
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
