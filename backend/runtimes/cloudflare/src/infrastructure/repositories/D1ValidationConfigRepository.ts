import type { ValidationConfigRecord, ValidationConfigRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ValidationConfigRow {
  workspace_id: string
  block_id: string
  checks: string
  max_attempts: number
  created_at: number
  updated_at: number
}

/**
 * Parse the persisted `checks` JSON array, tolerating a corrupt/legacy row: a malformed blob
 * degrades to "no checks configured", which is exactly the pre-feature behaviour, rather than
 * throwing inside a dispatch.
 */
function parseChecks(json: string): { label: string; command: string }[] {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .filter((x) => typeof x.command === 'string' && x.command !== '')
      .map((x) => ({
        label: typeof x.label === 'string' && x.label ? x.label : (x.command as string),
        command: x.command as string,
      }))
  } catch {
    return []
  }
}

function rowToRecord(row: ValidationConfigRow): ValidationConfigRecord {
  return {
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    checks: parseChecks(row.checks),
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Per-service-frame PRE-PR VALIDATION CHECKS (migration 0061): the commands the harness runs
 * against the checkout before opening a PR. `checks` is a JSON array as text. Mirrors the Node
 * facade's Drizzle repository — the cross-runtime conformance suite asserts they behave
 * identically. See docs/initiatives/pre-pr-validation.md.
 */
export class D1ValidationConfigRepository implements ValidationConfigRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<ValidationConfigRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM validation_configs WHERE workspace_id = ? AND block_id = ?`)
      .bind(workspaceId, blockId)
      .first<ValidationConfigRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<ValidationConfigRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM validation_configs WHERE workspace_id = ? ORDER BY block_id ASC`)
      .bind(workspaceId)
      .all<ValidationConfigRow>()
    return results.map(rowToRecord)
  }

  async upsert(record: ValidationConfigRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO validation_configs
           (workspace_id, block_id, checks, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, block_id) DO UPDATE SET
           checks = excluded.checks,
           max_attempts = excluded.max_attempts,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.blockId,
        JSON.stringify(record.checks),
        record.maxAttempts,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async delete(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM validation_configs WHERE workspace_id = ? AND block_id = ?`)
      .bind(workspaceId, blockId)
      .run()
  }
}
