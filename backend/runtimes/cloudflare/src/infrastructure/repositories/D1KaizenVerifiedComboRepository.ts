import type { KaizenVerifiedComboRepository } from '@cat-factory/kernel'
import type { KaizenVerifiedCombo } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface KaizenVerifiedComboRow {
  workspace_id: string
  combo_key: string
  agent_kind: string
  model: string
  prompt_version: number
  consecutive_high_grades: number
  verified: number
  verified_at: number | null
  updated_at: number
}

function rowToCombo(row: KaizenVerifiedComboRow): KaizenVerifiedCombo {
  return {
    comboKey: row.combo_key,
    agentKind: row.agent_kind,
    model: row.model,
    promptVersion: row.prompt_version,
    consecutiveHighGrades: row.consecutive_high_grades,
    verified: row.verified === 1,
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Kaizen verified-combo progress, one row per `(workspace, comboKey)` in
 * `kaizen_verified_combos` (migration 0015). Tracks each combo's streak of high grades
 * and whether it has crossed the verification threshold (after which the engine stops
 * scheduling gradings for it).
 */
export class D1KaizenVerifiedComboRepository implements KaizenVerifiedComboRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByKey(workspaceId: string, comboKey: string): Promise<KaizenVerifiedCombo | null> {
    const row = await this.db
      .prepare(`SELECT * FROM kaizen_verified_combos WHERE workspace_id = ? AND combo_key = ?`)
      .bind(workspaceId, comboKey)
      .first<KaizenVerifiedComboRow>()
    return row ? rowToCombo(row) : null
  }

  async upsert(workspaceId: string, combo: KaizenVerifiedCombo): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO kaizen_verified_combos
           (workspace_id, combo_key, agent_kind, model, prompt_version, consecutive_high_grades,
            verified, verified_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, combo_key) DO UPDATE SET
           consecutive_high_grades = excluded.consecutive_high_grades,
           verified = excluded.verified,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        workspaceId,
        combo.comboKey,
        combo.agentKind,
        combo.model,
        combo.promptVersion,
        combo.consecutiveHighGrades,
        combo.verified ? 1 : 0,
        combo.verifiedAt,
        combo.updatedAt,
      )
      .run()
  }

  async listByWorkspace(workspaceId: string): Promise<KaizenVerifiedCombo[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM kaizen_verified_combos
           WHERE workspace_id = ?
           ORDER BY updated_at DESC`,
      )
      .bind(workspaceId)
      .all<KaizenVerifiedComboRow>()
    return (results ?? []).map(rowToCombo)
  }
}
