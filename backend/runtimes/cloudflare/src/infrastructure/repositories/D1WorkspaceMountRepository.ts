import type {
  WorkspaceMount,
  WorkspaceMountPatch,
  WorkspaceMountRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { decodeMountSubjectKind } from '@cat-factory/contracts'
import { chunkForIn } from './chunk'

interface MountRow {
  workspace_id: string
  subject_kind: string
  subject_id: string
  pos_x: number
  pos_y: number
  width: number | null
  height: number | null
  created_at: number
}

function rowToMount(row: MountRow): WorkspaceMount {
  return {
    workspaceId: row.workspace_id,
    subjectKind: decodeMountSubjectKind(row.subject_kind),
    subjectId: row.subject_id,
    position: { x: row.pos_x, y: row.pos_y },
    size: row.width !== null && row.height !== null ? { w: row.width, h: row.height } : null,
    createdAt: row.created_at,
  }
}

/** A subject mounted onto a workspace board, with its per-workspace layout. */
export class D1WorkspaceMountRepository implements WorkspaceMountRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceMount[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM workspace_mounts WHERE workspace_id = ? ORDER BY created_at`)
      .bind(workspaceId)
      .all<MountRow>()
    return (results ?? []).map(rowToMount)
  }

  async listBySubjectIds(subjectIds: string[]): Promise<WorkspaceMount[]> {
    if (subjectIds.length === 0) return []
    const mounts: WorkspaceMount[] = []
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(subjectIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT * FROM workspace_mounts WHERE subject_id IN (${placeholders}) ORDER BY created_at`,
        )
        .bind(...chunk)
        .all<MountRow>()
      for (const row of results ?? []) mounts.push(rowToMount(row))
    }
    return mounts
  }

  async listWorkspaceIdsMountingBlock(
    originWorkspaceId: string,
    blockId: string,
  ): Promise<string[]> {
    // One join: the subject owning the block, then the workspaces that mount it. A block with no
    // owner makes the subquery NULL, which matches no rows (`subject_id = NULL`), so it is empty.
    const { results } = await this.db
      .prepare(
        `SELECT workspace_id FROM workspace_mounts
         WHERE subject_id = (SELECT owner_id FROM blocks WHERE workspace_id = ? AND id = ?)`,
      )
      .bind(originWorkspaceId, blockId)
      .all<{ workspace_id: string }>()
    return (results ?? []).map((r) => r.workspace_id)
  }

  async countBySubjectIds(subjectIds: string[]): Promise<Record<string, number>> {
    if (subjectIds.length === 0) return {}
    const counts: Record<string, number> = {}
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(subjectIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT subject_id, COUNT(*) AS n FROM workspace_mounts
           WHERE subject_id IN (${placeholders}) GROUP BY subject_id`,
        )
        .bind(...chunk)
        .all<{ subject_id: string; n: number }>()
      for (const row of results ?? []) counts[row.subject_id] = Number(row.n)
    }
    return counts
  }

  async get(workspaceId: string, subjectId: string): Promise<WorkspaceMount | null> {
    const row = await this.db
      .prepare(`SELECT * FROM workspace_mounts WHERE workspace_id = ? AND subject_id = ?`)
      .bind(workspaceId, subjectId)
      .first<MountRow>()
    return row ? rowToMount(row) : null
  }

  async upsert(mount: WorkspaceMount): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO workspace_mounts (workspace_id, subject_kind, subject_id, pos_x, pos_y, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, subject_id) DO UPDATE SET
           pos_x = excluded.pos_x,
           pos_y = excluded.pos_y,
           width = excluded.width,
           height = excluded.height`,
      )
      .bind(
        mount.workspaceId,
        mount.subjectKind,
        mount.subjectId,
        mount.position.x,
        mount.position.y,
        mount.size?.w ?? null,
        mount.size?.h ?? null,
        mount.createdAt,
      )
      .run()
  }

  async update(workspaceId: string, subjectId: string, patch: WorkspaceMountPatch): Promise<void> {
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
    binds.push(workspaceId, subjectId)
    await this.db
      .prepare(
        `UPDATE workspace_mounts SET ${sets.join(', ')} WHERE workspace_id = ? AND subject_id = ?`,
      )
      .bind(...binds)
      .run()
  }

  async remove(workspaceId: string, subjectId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM workspace_mounts WHERE workspace_id = ? AND subject_id = ?`)
      .bind(workspaceId, subjectId)
      .run()
  }

  async removeBySubjects(subjectIds: string[]): Promise<void> {
    if (subjectIds.length === 0) return
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(subjectIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      await this.db
        .prepare(`DELETE FROM workspace_mounts WHERE subject_id IN (${placeholders})`)
        .bind(...chunk)
        .run()
    }
  }
}
