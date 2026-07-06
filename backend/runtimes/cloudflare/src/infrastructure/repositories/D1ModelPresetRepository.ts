import type { ModelPresetRepository } from '@cat-factory/kernel'
import type { ModelPreset } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface ModelPresetRow {
  id: string
  name: string
  base_model_id: string
  overrides: string
  is_default: number
  version: number | null
  created_at: number
}

function rowToPreset(row: ModelPresetRow): ModelPreset {
  let overrides: Record<string, string> = {}
  try {
    const parsed = JSON.parse(row.overrides) as unknown
    if (parsed && typeof parsed === 'object') overrides = parsed as Record<string, string>
  } catch {
    // A malformed JSON column degrades to no overrides (base model applies to all).
  }
  return {
    id: row.id,
    name: row.name,
    baseModelId: row.base_model_id,
    overrides,
    isDefault: row.is_default === 1,
    ...(row.version != null ? { version: row.version } : {}),
    createdAt: row.created_at,
  }
}

/**
 * Model presets, one row per preset in `model_presets` (migration 0006), `overrides`
 * a JSON object. Enforces the single-default invariant: promoting a preset to default
 * demotes every other in the workspace, in one statement before the upsert. The
 * default preset cannot be removed (the service keeps that rule).
 */
export class D1ModelPresetRepository implements ModelPresetRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<ModelPreset | null> {
    const row = await this.db
      .prepare(`SELECT * FROM model_presets WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<ModelPresetRow>()
    return row ? rowToPreset(row) : null
  }

  async list(workspaceId: string): Promise<ModelPreset[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM model_presets WHERE workspace_id = ? ORDER BY created_at ASC`)
      .bind(workspaceId)
      .all<ModelPresetRow>()
    return results.map(rowToPreset)
  }

  async getDefault(workspaceId: string): Promise<ModelPreset | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM model_presets
           WHERE workspace_id = ? AND is_default = 1
           ORDER BY created_at ASC LIMIT 1`,
      )
      .bind(workspaceId)
      .first<ModelPresetRow>()
    return row ? rowToPreset(row) : null
  }

  async upsert(workspaceId: string, preset: ModelPreset): Promise<void> {
    // Demote + upsert run in ONE batch so the single-default invariant can never be
    // observed broken (zero or two defaults) by a concurrent reader or a partial
    // failure — matching the Drizzle mirror's transaction. Promoting this preset to
    // default demotes any other default in the same atomic step.
    const statements = []
    if (preset.isDefault) {
      statements.push(
        this.db
          .prepare(`UPDATE model_presets SET is_default = 0 WHERE workspace_id = ? AND id <> ?`)
          .bind(workspaceId, preset.id),
      )
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO model_presets
             (workspace_id, id, name, base_model_id, overrides, is_default, version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, id) DO UPDATE SET
             name = excluded.name,
             base_model_id = excluded.base_model_id,
             overrides = excluded.overrides,
             is_default = excluded.is_default,
             version = excluded.version`,
        )
        .bind(
          workspaceId,
          preset.id,
          preset.name,
          preset.baseModelId,
          JSON.stringify(preset.overrides),
          preset.isDefault ? 1 : 0,
          preset.version ?? null,
          preset.createdAt,
        ),
    )
    await this.db.batch(statements)
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM model_presets WHERE workspace_id = ? AND id = ? AND is_default = 0`)
      .bind(workspaceId, id)
      .run()
  }
}
