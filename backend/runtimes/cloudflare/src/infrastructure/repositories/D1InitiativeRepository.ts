import type { Initiative, InitiativeRepository } from '@cat-factory/kernel'
import { decodeInitiativeRow } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface InitiativeRow {
  workspace_id: string
  id: string
  block_id: string
  slug: string
  status: string
  rev: number
  doc: string
  created_at: number
  updated_at: number
}

// The row → entity decode (doc blob + column-lifted keys) is the shared
// `decodeInitiativeRow` (contracts), so the D1 and Drizzle repos can't drift.
const rowToInitiative = decodeInitiativeRow

/**
 * Initiatives, one row per entity in `initiatives` (migration 0035). The entity
 * body is a JSON `doc` blob with the loop-relevant keys lifted into columns; every
 * post-insert write goes through the rev-guarded `compareAndSwap` (an `UPDATE …
 * WHERE rev = ?` whose changed-row count decides the winner).
 */
export class D1InitiativeRepository implements InitiativeRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<Initiative | null> {
    const row = await this.db
      .prepare('SELECT * FROM initiatives WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<InitiativeRow>()
    return row ? rowToInitiative(row) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<Initiative | null> {
    const row = await this.db
      .prepare('SELECT * FROM initiatives WHERE workspace_id = ? AND block_id = ?')
      .bind(workspaceId, blockId)
      .first<InitiativeRow>()
    return row ? rowToInitiative(row) : null
  }

  async list(workspaceId: string): Promise<Initiative[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM initiatives WHERE workspace_id = ? ORDER BY created_at')
      .bind(workspaceId)
      .all<InitiativeRow>()
    // Snapshot-facing list read: drop a corrupt row rather than failing the board load.
    return (results ?? []).map(rowToInitiative).filter((i): i is Initiative => i !== null)
  }

  async listExecuting(): Promise<Array<{ workspaceId: string; initiative: Initiative }>> {
    const { results } = await this.db
      .prepare("SELECT * FROM initiatives WHERE status = 'executing' ORDER BY created_at")
      .all<InitiativeRow>()
    return (results ?? [])
      .map((row) => {
        const initiative = rowToInitiative(row)
        return initiative ? { workspaceId: row.workspace_id, initiative } : null
      })
      .filter((r): r is { workspaceId: string; initiative: Initiative } => r !== null)
  }

  async insert(workspaceId: string, initiative: Initiative): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO initiatives
           (workspace_id, id, block_id, slug, status, rev, doc, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        workspaceId,
        initiative.id,
        initiative.blockId,
        initiative.slug,
        initiative.status,
        initiative.rev,
        JSON.stringify(initiative),
        initiative.createdAt,
        initiative.updatedAt,
      )
      .run()
  }

  async compareAndSwap(
    workspaceId: string,
    next: Initiative,
    expectedRev: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE initiatives
           SET slug = ?, status = ?, rev = ?, doc = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND rev = ?`,
      )
      .bind(
        next.slug,
        next.status,
        next.rev,
        JSON.stringify(next),
        next.updatedAt,
        workspaceId,
        next.id,
        expectedRev,
      )
      .run()
    return (result.meta?.changes ?? 0) > 0
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM initiatives WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .run()
  }
}
