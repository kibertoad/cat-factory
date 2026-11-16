import type { TaskProjectLink, TaskProjectLinkRepository } from '@cat-factory/kernel'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { taskProjectLinks } from '../../db/schema.js'

const CHUNK = 500

/** The projects linked to tasks as read-only context. */
export class DrizzleTaskProjectLinkRepository implements TaskProjectLinkRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByBlock(workspaceId: string, blockId: string): Promise<TaskProjectLink[]> {
    const rows = await this.db
      .select()
      .from(taskProjectLinks)
      .where(
        and(eq(taskProjectLinks.workspace_id, workspaceId), eq(taskProjectLinks.block_id, blockId)),
      )
      .orderBy(asc(taskProjectLinks.created_at), asc(taskProjectLinks.project_id))
    return rows.map((row) => ({
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
    await this.db
      .insert(taskProjectLinks)
      .values(
        projectIds.map((projectId) => ({
          workspace_id: workspaceId,
          block_id: blockId,
          project_id: projectId,
          created_at: createdAt,
        })),
      )
      .onConflictDoNothing({
        target: [
          taskProjectLinks.workspace_id,
          taskProjectLinks.block_id,
          taskProjectLinks.project_id,
        ],
      })
  }

  async unlink(workspaceId: string, blockId: string, projectId: string): Promise<void> {
    await this.db
      .delete(taskProjectLinks)
      .where(
        and(
          eq(taskProjectLinks.workspace_id, workspaceId),
          eq(taskProjectLinks.block_id, blockId),
          eq(taskProjectLinks.project_id, projectId),
        ),
      )
  }

  async deleteByBlocks(workspaceId: string, blockIds: string[]): Promise<void> {
    for (let i = 0; i < blockIds.length; i += CHUNK) {
      await this.db
        .delete(taskProjectLinks)
        .where(
          and(
            eq(taskProjectLinks.workspace_id, workspaceId),
            inArray(taskProjectLinks.block_id, blockIds.slice(i, i + CHUNK)),
          ),
        )
    }
  }

  async deleteByProjects(projectIds: string[]): Promise<void> {
    for (let i = 0; i < projectIds.length; i += CHUNK) {
      await this.db
        .delete(taskProjectLinks)
        .where(inArray(taskProjectLinks.project_id, projectIds.slice(i, i + CHUNK)))
    }
  }
}
