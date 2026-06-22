import type { MergePresetRepository } from '@cat-factory/kernel'
import type { MergeThresholdPreset, RequirementConcernLevel } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface MergePresetRow {
  id: string
  name: string
  max_complexity: number
  max_risk: number
  max_impact: number
  ci_max_attempts: number
  max_requirement_iterations: number
  max_requirement_concern_allowed: string
  is_default: number
  created_at: number
}

function rowToPreset(row: MergePresetRow): MergeThresholdPreset {
  return {
    id: row.id,
    name: row.name,
    maxComplexity: row.max_complexity,
    maxRisk: row.max_risk,
    maxImpact: row.max_impact,
    ciMaxAttempts: row.ci_max_attempts,
    maxRequirementIterations: row.max_requirement_iterations,
    maxRequirementConcernAllowed:
      row.max_requirement_concern_allowed as RequirementConcernLevel,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  }
}

/**
 * Merge threshold presets, one row per preset in `merge_threshold_presets`
 * (migration 0024). Enforces the single-default invariant: promoting a preset to
 * default demotes every other in the workspace, in one statement before the
 * upsert. The default preset cannot be removed (the service keeps that rule).
 */
export class D1MergePresetRepository implements MergePresetRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<MergeThresholdPreset | null> {
    const row = await this.db
      .prepare(`SELECT * FROM merge_threshold_presets WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<MergePresetRow>()
    return row ? rowToPreset(row) : null
  }

  async list(workspaceId: string): Promise<MergeThresholdPreset[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM merge_threshold_presets WHERE workspace_id = ? ORDER BY created_at ASC`,
      )
      .bind(workspaceId)
      .all<MergePresetRow>()
    return results.map(rowToPreset)
  }

  async getDefault(workspaceId: string): Promise<MergeThresholdPreset | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM merge_threshold_presets
           WHERE workspace_id = ? AND is_default = 1
           ORDER BY created_at ASC LIMIT 1`,
      )
      .bind(workspaceId)
      .first<MergePresetRow>()
    return row ? rowToPreset(row) : null
  }

  async upsert(workspaceId: string, preset: MergeThresholdPreset): Promise<void> {
    // Promoting this preset to default demotes any other default first, so the
    // single-default invariant holds.
    if (preset.isDefault) {
      await this.db
        .prepare(
          `UPDATE merge_threshold_presets SET is_default = 0
             WHERE workspace_id = ? AND id <> ?`,
        )
        .bind(workspaceId, preset.id)
        .run()
    }
    await this.db
      .prepare(
        `INSERT INTO merge_threshold_presets
           (workspace_id, id, name, max_complexity, max_risk, max_impact, ci_max_attempts,
            max_requirement_iterations, max_requirement_concern_allowed, is_default, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           name = excluded.name,
           max_complexity = excluded.max_complexity,
           max_risk = excluded.max_risk,
           max_impact = excluded.max_impact,
           ci_max_attempts = excluded.ci_max_attempts,
           max_requirement_iterations = excluded.max_requirement_iterations,
           max_requirement_concern_allowed = excluded.max_requirement_concern_allowed,
           is_default = excluded.is_default`,
      )
      .bind(
        workspaceId,
        preset.id,
        preset.name,
        preset.maxComplexity,
        preset.maxRisk,
        preset.maxImpact,
        preset.ciMaxAttempts,
        preset.maxRequirementIterations,
        preset.maxRequirementConcernAllowed,
        preset.isDefault ? 1 : 0,
        preset.createdAt,
      )
      .run()
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM merge_threshold_presets WHERE workspace_id = ? AND id = ? AND is_default = 0`,
      )
      .bind(workspaceId, id)
      .run()
  }
}
