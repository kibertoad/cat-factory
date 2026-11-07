import type { TaskProjectLink, TaskProjectLinkRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface LinkRow {
  workspace_id: string
  block_id: string
  project_id: string
  created_at: number
}

/** The projects linked to tasks as read-only context (migration 0117). */
export class D1TaskProjectLinkRepository implements TaskProjectLinkRepository {
  constructor(private readonly deps: { db: D1Database }) {}

  async listByBlock(workspaceId: string, blockId: string): Promise<TaskProjectLink[]> {
    const { results } = await this.deps.db
      .prepare(
        `SELECT * FROM task_project_links WHERE workspace_id = ? AND block_id = ?
         ORDER BY created_at, project_id`,
      )
      .bind(workspaceId, blockId)
      .all<LinkRow>()
    return (results ?? []).map((row) => ({
      workspaceId: row.workspace_id,
      blockId: row.block_id,
      projectId: row.project_id,
      createdAt: row.created_at,
    }))
  }

  async link(
    workspaceId: string,
    blockId: string,
    projectIds: string[],
    createdAt: number,
  ): Promise<void> {
    if (projectIds.length === 0) return
    await this.deps.db.batch(
      projectIds.map((projectId) =>
        this.deps.db
          .prepare(
            `INSERT INTO task_project_links (workspace_id, block_id, project_id, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(workspace_id, block_id, project_id) DO NOTHING`,
          )
          .bind(workspaceId, blockId, projectId, createdAt),
      ),
    )
  }

  async unlink(workspaceId: string, blockId: string, projectId: string): Promise<void> {
    await this.deps.db
      .prepare(
        `DELETE FROM task_project_links WHERE workspace_id = ? AND block_id = ? AND project_id = ?`,
      )
      .bind(workspaceId, blockId, projectId)
      .run()
  }

  async deleteByBlocks(workspaceId: string, blockIds: string[]): Promise<void> {
    for (const chunk of chunkForIn(blockIds, 1)) {
      await this.deps.db
        .prepare(
          `DELETE FROM task_project_links
           WHERE workspace_id = ? AND block_id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .bind(workspaceId, ...chunk)
        .run()
    }
  }

  async deleteByProjects(projectIds: string[]): Promise<void> {
    for (const chunk of chunkForIn(projectIds)) {
      await this.deps.db
        .prepare(
          `DELETE FROM task_project_links WHERE project_id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .bind(...chunk)
        .run()
    }
  }
}
