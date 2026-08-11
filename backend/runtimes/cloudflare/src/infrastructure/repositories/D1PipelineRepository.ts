import type { PipelineRepository } from '@cat-factory/kernel'
import type { Pipeline, RunDefaultScope } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { type PipelineRow, rowToPipeline } from './mappers'

/**
 * The insert statement and its bindings, shared by `insert` and `insertIfAbsent` so the
 * twenty-column projection is written once: the two differ only in the conflict clause appended
 * to this SQL.
 */
const INSERT_PIPELINE_SQL =
  'INSERT INTO pipelines (workspace_id, id, name, description, agent_kinds, gates, thresholds, enabled, consensus, gating, follow_ups, tester_quality, step_options, labels, archived, builtin, version, public, availability, purpose, is_default, is_unattended_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

/** The column one default scope is stored in; the ONE place that mapping lives on this facade. */
const PIPELINE_DEFAULT_COLUMN: Record<RunDefaultScope, 'is_default' | 'is_unattended_default'> = {
  interactive: 'is_default',
  unattended: 'is_unattended_default',
}

function pipelineBindings(workspaceId: string, pipeline: Pipeline): unknown[] {
  return [
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
    pipeline.purpose,
    // NULL rather than 0 when the row claims nothing, so the partial unique index that keeps one
    // default per scope sees only the rows that DO claim it.
    pipeline.isDefault ? 1 : null,
    pipeline.isUnattendedDefault ? 1 : null,
  ]
}

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
      .prepare(INSERT_PIPELINE_SQL)
      .bind(...pipelineBindings(workspaceId, pipeline))
      .run()
  }

  async insertIfAbsent(workspaceId: string, pipeline: Pipeline): Promise<void> {
    // Conflict-TARGETED on the composite key, so losing the adoption race is a no-op while a
    // genuine constraint violation still throws (see the port's contract). Deliberately NOT
    // `INSERT OR IGNORE`, which would also swallow any other constraint failure on this runtime
    // alone and so hide a real bug behind a passing Postgres suite.
    await this.db
      .prepare(`${INSERT_PIPELINE_SQL} ON CONFLICT(workspace_id, id) DO NOTHING`)
      .bind(...pipelineBindings(workspaceId, pipeline))
      .run()
  }

  async update(workspaceId: string, pipeline: Pipeline): Promise<void> {
    // UPDATE (not delete+insert) preserves the row's rowid, so an edited pipeline keeps
    // its place in the catalog order. `builtin` is immutable, so it is not rewritten.
    // `version` IS rewritten so a reseed bumps the stored copy to the current catalog version.
    // The two default flags are deliberately absent: `setDefault` owns them, so an edit or a
    // reseed of a rung an operator had promoted cannot silently un-promote it.
    await this.db
      .prepare(
        'UPDATE pipelines SET name = ?, description = ?, agent_kinds = ?, gates = ?, thresholds = ?, enabled = ?, consensus = ?, gating = ?, follow_ups = ?, tester_quality = ?, step_options = ?, labels = ?, archived = ?, version = ?, public = ?, availability = ?, purpose = ? WHERE workspace_id = ? AND id = ?',
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
        pipeline.purpose,
        workspaceId,
        pipeline.id,
      )
      .run()
  }

  async setDefault(
    workspaceId: string,
    id: string,
    scope: RunDefaultScope,
    claimed: boolean,
  ): Promise<void> {
    const column = PIPELINE_DEFAULT_COLUMN[scope]
    // ONE `batch`, which D1 runs as a single implicit transaction, mirroring the Drizzle
    // repository's explicit `db.transaction`: a demote that committed before a failed promote would
    // leave the scope with no holder at all, which is a state no caller asked for. The demote drops
    // EVERY holder rather than the one row that should be there, which is what heals a workspace
    // whose rows predate the partial unique index.
    const demote = this.db
      .prepare(`UPDATE pipelines SET ${column} = NULL WHERE workspace_id = ? AND ${column} = 1`)
      .bind(workspaceId)
    if (!claimed) {
      await demote.run()
      return
    }
    await this.db.batch([
      demote,
      this.db
        .prepare(`UPDATE pipelines SET ${column} = 1 WHERE workspace_id = ? AND id = ?`)
        .bind(workspaceId, id),
    ])
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM pipelines WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .run()
  }
}
