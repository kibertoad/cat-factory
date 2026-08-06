import type { TaskTypeSuppressionRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

/**
 * Per-workspace suppressions of registered custom task types in `task_type_suppressions`
 * (migration 0083). Tombstones: a row means the workspace hides that operation, and a restore
 * deletes it. See the port for why absence is the default.
 *
 * `suppress` is conflict-targeted on the full primary key rather than `INSERT OR IGNORE`, which
 * would also swallow an unrelated constraint failure on SQLite while the Postgres suite stayed
 * green (the D1 half of the `insertIfAbsent` rule).
 */
export class D1TaskTypeSuppressionRepository implements TaskTypeSuppressionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async list(workspaceId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT task_type FROM task_type_suppressions
           WHERE workspace_id = ?
           ORDER BY task_type ASC`,
      )
      .bind(workspaceId)
      .all<{ task_type: string }>()
    return results.map((row) => row.task_type)
  }

  async suppress(workspaceId: string, taskType: string, createdAt: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO task_type_suppressions (workspace_id, task_type, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id, task_type) DO NOTHING`,
      )
      .bind(workspaceId, taskType, createdAt)
      .run()
  }

  async restore(workspaceId: string, taskType: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM task_type_suppressions WHERE workspace_id = ? AND task_type = ?`)
      .bind(workspaceId, taskType)
      .run()
  }
}
