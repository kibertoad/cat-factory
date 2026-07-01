import type { CustomManifestTypeRecord, CustomManifestTypeRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// D1-backed store of workspace-defined custom-manifest-type catalog entries, keyed by
// (workspace_id, manifest_id). Migration 0024.

interface CustomManifestTypeRow {
  workspace_id: string
  manifest_id: string
  label: string
  accepts_input_hint: string | null
  description: string | null
  default_manifest_path: string | null
  fixer_prompt: string | null
  created_at: number
  updated_at: number
}

function toRecord(row: CustomManifestTypeRow): CustomManifestTypeRecord {
  return {
    workspaceId: row.workspace_id,
    manifestId: row.manifest_id,
    label: row.label,
    acceptsInputHint: row.accepts_input_hint,
    description: row.description,
    defaultManifestPath: row.default_manifest_path,
    fixerPrompt: row.fixer_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class D1CustomManifestTypeRepository implements CustomManifestTypeRepository {
  private readonly db: D1Database
  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByWorkspace(workspaceId: string): Promise<CustomManifestTypeRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM custom_manifest_types WHERE workspace_id = ? ORDER BY created_at ASC`)
      .bind(workspaceId)
      .all<CustomManifestTypeRow>()
    return (results ?? []).map(toRecord)
  }

  async upsert(record: CustomManifestTypeRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO custom_manifest_types
           (workspace_id, manifest_id, label, accepts_input_hint, description, default_manifest_path, fixer_prompt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, manifest_id) DO UPDATE SET
           label = excluded.label,
           accepts_input_hint = excluded.accepts_input_hint,
           description = excluded.description,
           default_manifest_path = excluded.default_manifest_path,
           fixer_prompt = excluded.fixer_prompt,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.manifestId,
        record.label,
        record.acceptsInputHint,
        record.description,
        record.defaultManifestPath,
        record.fixerPrompt,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async remove(workspaceId: string, manifestId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM custom_manifest_types WHERE workspace_id = ? AND manifest_id = ?`)
      .bind(workspaceId, manifestId)
      .run()
  }
}
