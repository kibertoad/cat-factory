import type { ServiceFragmentDefaultsRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

/**
 * A workspace's default service-fragment selection — one row per workspace in
 * `workspace_fragment_defaults` (migration 0040), the fragment ids stored as a JSON
 * array. `set` upserts the whole list for the workspace.
 */
export class D1ServiceFragmentDefaultsRepository implements ServiceFragmentDefaultsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<string[]> {
    const row = await this.db
      .prepare(`SELECT fragment_ids FROM workspace_fragment_defaults WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<{ fragment_ids: string }>()
    return row ? (JSON.parse(row.fragment_ids) as string[]) : []
  }

  async set(workspaceId: string, fragmentIds: string[]): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO workspace_fragment_defaults (workspace_id, fragment_ids, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET fragment_ids = excluded.fragment_ids, updated_at = excluded.updated_at`,
      )
      .bind(workspaceId, JSON.stringify(fragmentIds), Date.now())
      .run()
  }
}
