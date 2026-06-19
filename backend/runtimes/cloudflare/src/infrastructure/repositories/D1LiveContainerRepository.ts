import type { D1Database } from '@cloudflare/workers-types'
import type {
  LiveContainerRecord,
  LiveContainerStore,
} from '../containers/ContainerInstanceRegistry'

/**
 * The live-container inventory over D1 (`live_containers`, migration 0022). `add`
 * uses `ON CONFLICT(container_key) DO NOTHING` so a replayed dispatch preserves the
 * first `started_at` — the container's true age the reaper keys off.
 */
export class D1LiveContainerRepository implements LiveContainerStore {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async add(record: LiveContainerRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO live_containers (container_key, kind, workspace_id, started_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(container_key) DO NOTHING`,
      )
      .bind(record.containerKey, record.kind, record.workspaceId ?? null, record.startedAt)
      .run()
  }

  async remove(containerKey: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM live_containers WHERE container_key = ?')
      .bind(containerKey)
      .run()
  }

  async listStartedBefore(epochMs: number): Promise<LiveContainerRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT container_key, kind, workspace_id, started_at FROM live_containers
         WHERE started_at < ?
         ORDER BY started_at`,
      )
      .bind(epochMs)
      .all<{
        container_key: string
        kind: string
        workspace_id: string | null
        started_at: number
      }>()
    return (results ?? []).map((r) => ({
      containerKey: r.container_key,
      kind: r.kind,
      ...(r.workspace_id != null ? { workspaceId: r.workspace_id } : {}),
      startedAt: r.started_at,
    }))
  }
}
