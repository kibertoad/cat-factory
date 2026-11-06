import type { Project } from '@cat-factory/contracts'
import type { ProjectRepository } from '@cat-factory/kernel'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface ProjectRow {
  id: string
  account_id: string | null
  kind: string
  root_block_id: string
  created_at: number
}

interface LinkRow {
  project_id: string
  service_id: string
  position: number
}

/** Account-owned projects and their ordered service links (migration 0114). */
export class D1ProjectRepository implements ProjectRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(id: string): Promise<Project | null> {
    return (await this.listByIds([id]))[0] ?? null
  }

  async listByIds(ids: string[]): Promise<Project[]> {
    return this.listWhereIn('id', ids)
  }

  async listByRootBlocks(rootBlockIds: string[]): Promise<Project[]> {
    return this.listWhereIn('root_block_id', rootBlockIds)
  }

  async listByAccount(accountId: string | null): Promise<Project[]> {
    // `IS` matches NULL too, so the unscoped org (accountId null) lists cleanly.
    const { results } = await this.db
      .prepare(`SELECT * FROM projects WHERE account_id IS ? ORDER BY created_at`)
      .bind(accountId)
      .all<ProjectRow>()
    return this.withLinks(results ?? [])
  }

  async insert(project: Project): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO projects (id, account_id, kind, root_block_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(project.id, project.accountId, project.kind, project.rootBlockId, project.createdAt),
      ...this.linkInserts(project.id, project.serviceIds),
    ])
  }

  async setServiceLinks(projectId: string, serviceIds: string[]): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM project_service_links WHERE project_id = ?`).bind(projectId),
      ...this.linkInserts(projectId, serviceIds),
    ])
  }

  async unlinkServices(serviceIds: string[]): Promise<void> {
    for (const chunk of chunkForIn(serviceIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      await this.db
        .prepare(`DELETE FROM project_service_links WHERE service_id IN (${placeholders})`)
        .bind(...chunk)
        .run()
    }
  }

  async deleteMany(ids: string[]): Promise<void> {
    for (const chunk of chunkForIn(ids)) {
      const placeholders = chunk.map(() => '?').join(', ')
      await this.db.batch([
        this.db
          .prepare(`DELETE FROM project_service_links WHERE project_id IN (${placeholders})`)
          .bind(...chunk),
        this.db.prepare(`DELETE FROM projects WHERE id IN (${placeholders})`).bind(...chunk),
      ])
    }
  }

  private linkInserts(projectId: string, serviceIds: string[]): D1PreparedStatement[] {
    return serviceIds.map((serviceId, position) =>
      this.db
        .prepare(
          `INSERT INTO project_service_links (project_id, service_id, position) VALUES (?, ?, ?)`,
        )
        .bind(projectId, serviceId, position),
    )
  }

  private async listWhereIn(column: 'id' | 'root_block_id', values: string[]): Promise<Project[]> {
    if (values.length === 0) return []
    const rows: ProjectRow[] = []
    for (const chunk of chunkForIn(values)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(`SELECT * FROM projects WHERE ${column} IN (${placeholders})`)
        .bind(...chunk)
        .all<ProjectRow>()
      rows.push(...(results ?? []))
    }
    return this.withLinks(rows)
  }

  /** Attach each project's links with one batched read over all of them. */
  private async withLinks(rows: ProjectRow[]): Promise<Project[]> {
    const links = new Map<string, LinkRow[]>()
    for (const chunk of chunkForIn(rows.map((r) => r.id))) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT * FROM project_service_links WHERE project_id IN (${placeholders}) ORDER BY position`,
        )
        .bind(...chunk)
        .all<LinkRow>()
      for (const link of results ?? []) {
        const list = links.get(link.project_id)
        if (list) list.push(link)
        else links.set(link.project_id, [link])
      }
    }
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      kind: row.kind,
      rootBlockId: row.root_block_id,
      serviceIds: (links.get(row.id) ?? []).map((link) => link.service_id),
      createdAt: row.created_at,
    }))
  }
}
