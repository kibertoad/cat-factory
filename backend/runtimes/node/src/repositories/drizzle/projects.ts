import type { Project } from '@cat-factory/contracts'
import type { ProjectRepository } from '@cat-factory/kernel'
import { asc, eq, inArray, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { projectServiceLinks, projects } from '../../db/schema.js'

const CHUNK = 500

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK))
  return out
}

/** Account-owned projects and their ordered service links. */
export class DrizzleProjectRepository implements ProjectRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(id: string): Promise<Project | null> {
    return (await this.listByIds([id]))[0] ?? null
  }

  async listByIds(ids: string[]): Promise<Project[]> {
    const rows: (typeof projects.$inferSelect)[] = []
    for (const chunk of chunks(ids)) {
      rows.push(...(await this.db.select().from(projects).where(inArray(projects.id, chunk))))
    }
    return this.withLinks(rows)
  }

  async listByRootBlocks(rootBlockIds: string[]): Promise<Project[]> {
    const rows: (typeof projects.$inferSelect)[] = []
    for (const chunk of chunks(rootBlockIds)) {
      rows.push(
        ...(await this.db.select().from(projects).where(inArray(projects.root_block_id, chunk))),
      )
    }
    return this.withLinks(rows)
  }

  async listByAccount(accountId: string | null): Promise<Project[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(accountId === null ? isNull(projects.account_id) : eq(projects.account_id, accountId))
      .orderBy(asc(projects.created_at))
    return this.withLinks(rows)
  }

  async insert(project: Project): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id: project.id,
        account_id: project.accountId,
        kind: project.kind,
        root_block_id: project.rootBlockId,
        created_at: project.createdAt,
      })
      if (project.serviceIds.length) {
        await tx.insert(projectServiceLinks).values(linkRows(project.id, project.serviceIds))
      }
    })
  }

  async setServiceLinks(projectId: string, serviceIds: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(projectServiceLinks).where(eq(projectServiceLinks.project_id, projectId))
      if (serviceIds.length) {
        await tx.insert(projectServiceLinks).values(linkRows(projectId, serviceIds))
      }
    })
  }

  async unlinkServices(serviceIds: string[]): Promise<void> {
    for (const chunk of chunks(serviceIds)) {
      await this.db
        .delete(projectServiceLinks)
        .where(inArray(projectServiceLinks.service_id, chunk))
    }
  }

  async deleteMany(ids: string[]): Promise<void> {
    for (const chunk of chunks(ids)) {
      await this.db.transaction(async (tx) => {
        await tx.delete(projectServiceLinks).where(inArray(projectServiceLinks.project_id, chunk))
        await tx.delete(projects).where(inArray(projects.id, chunk))
      })
    }
  }

  /** Attach each project's links with one batched read over all of them. */
  private async withLinks(rows: (typeof projects.$inferSelect)[]): Promise<Project[]> {
    const links = new Map<string, string[]>()
    for (const chunk of chunks(rows.map((r) => r.id))) {
      const found = await this.db
        .select()
        .from(projectServiceLinks)
        .where(inArray(projectServiceLinks.project_id, chunk))
        .orderBy(asc(projectServiceLinks.position))
      for (const link of found) {
        const list = links.get(link.project_id)
        if (list) list.push(link.service_id)
        else links.set(link.project_id, [link.service_id])
      }
    }
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      kind: row.kind,
      rootBlockId: row.root_block_id,
      serviceIds: links.get(row.id) ?? [],
      createdAt: row.created_at,
    }))
  }
}

function linkRows(projectId: string, serviceIds: string[]) {
  return serviceIds.map((serviceId, position) => ({
    project_id: projectId,
    service_id: serviceId,
    position,
  }))
}
