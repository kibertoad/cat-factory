import type {
  WorkspaceMount,
  WorkspaceMountPatch,
  WorkspaceMountRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface MountRow {
  workspace_id: string
  service_id: string
  pos_x: number
  pos_y: number
  width: number | null
  height: number | null
  created_at: number
}

function rowToMount(row: MountRow): WorkspaceMount {
  return {
    workspaceId: row.workspace_id,
    serviceId: row.service_id,
    position: { x: row.pos_x, y: row.pos_y },
    size: row.width !== null && row.height !== null ? { w: row.width, h: row.height } : null,
    createdAt: row.created_at,
  }
}

/** A service mounted onto a workspace board + its per-workspace layout (migration 0030). */
export class D1WorkspaceMountRepository implements WorkspaceMountRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceMount[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM workspace_services WHERE workspace_id = ? ORDER BY created_at`)
      .bind(workspaceId)
      .all<MountRow>()
    return (results ?? []).map(rowToMount)
  }

  async listByService(serviceId: string): Promise<WorkspaceMount[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM workspace_services WHERE service_id = ? ORDER BY created_at`)
      .bind(serviceId)
      .all<MountRow>()
    return (results ?? []).map(rowToMount)
  }

  async get(workspaceId: string, serviceId: string): Promise<WorkspaceMount | null> {
    const row = await this.db
      .prepare(`SELECT * FROM workspace_services WHERE workspace_id = ? AND service_id = ?`)
      .bind(workspaceId, serviceId)
      .first<MountRow>()
    return row ? rowToMount(row) : null
  }

  async upsert(mount: WorkspaceMount): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO workspace_services (workspace_id, service_id, pos_x, pos_y, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, service_id) DO UPDATE SET
           pos_x = excluded.pos_x,
           pos_y = excluded.pos_y,
           width = excluded.width,
           height = excluded.height`,
      )
      .bind(
        mount.workspaceId,
        mount.serviceId,
        mount.position.x,
        mount.position.y,
        mount.size?.w ?? null,
        mount.size?.h ?? null,
        mount.createdAt,
      )
      .run()
  }

  async update(workspaceId: string, serviceId: string, patch: WorkspaceMountPatch): Promise<void> {
    const sets: string[] = []
    const binds: unknown[] = []
    if (patch.position) {
      sets.push('pos_x = ?', 'pos_y = ?')
      binds.push(patch.position.x, patch.position.y)
    }
    if ('size' in patch) {
      sets.push('width = ?', 'height = ?')
      binds.push(patch.size?.w ?? null, patch.size?.h ?? null)
    }
    if (sets.length === 0) return
    binds.push(workspaceId, serviceId)
    await this.db
      .prepare(
        `UPDATE workspace_services SET ${sets.join(', ')} WHERE workspace_id = ? AND service_id = ?`,
      )
      .bind(...binds)
      .run()
  }

  async remove(workspaceId: string, serviceId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM workspace_services WHERE workspace_id = ? AND service_id = ?`)
      .bind(workspaceId, serviceId)
      .run()
  }
}
