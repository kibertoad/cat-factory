import type { Service, ServicePatch, ServiceRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ServiceRow {
  id: string
  account_id: string | null
  frame_block_id: string
  installation_id: number | null
  repo_github_id: number | null
  created_at: number
}

function rowToService(row: ServiceRow): Service {
  return {
    id: row.id,
    accountId: row.account_id,
    frameBlockId: row.frame_block_id,
    installationId: row.installation_id,
    repoGithubId: row.repo_github_id,
    createdAt: row.created_at,
  }
}

/** Account-owned services (migration 0030). The canonical, shareable board unit. */
export class D1ServiceRepository implements ServiceRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(id: string): Promise<Service | null> {
    const row = await this.db
      .prepare(`SELECT * FROM services WHERE id = ?`)
      .bind(id)
      .first<ServiceRow>()
    return row ? rowToService(row) : null
  }

  async getByFrameBlock(frameBlockId: string): Promise<Service | null> {
    const row = await this.db
      .prepare(`SELECT * FROM services WHERE frame_block_id = ?`)
      .bind(frameBlockId)
      .first<ServiceRow>()
    return row ? rowToService(row) : null
  }

  async listByAccount(accountId: string | null): Promise<Service[]> {
    // `IS` matches NULL too, so the legacy/unscoped org (accountId null) lists cleanly.
    const { results } = await this.db
      .prepare(`SELECT * FROM services WHERE account_id IS ? ORDER BY created_at`)
      .bind(accountId)
      .all<ServiceRow>()
    return (results ?? []).map(rowToService)
  }

  async getByRepo(installationId: number, repoGithubId: number): Promise<Service | null> {
    const row = await this.db
      .prepare(`SELECT * FROM services WHERE installation_id = ? AND repo_github_id = ?`)
      .bind(installationId, repoGithubId)
      .first<ServiceRow>()
    return row ? rowToService(row) : null
  }

  async insert(service: Service): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO services (id, account_id, frame_block_id, installation_id, repo_github_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        service.id,
        service.accountId,
        service.frameBlockId,
        service.installationId,
        service.repoGithubId,
        service.createdAt,
      )
      .run()
  }

  async update(id: string, patch: ServicePatch): Promise<void> {
    const sets: string[] = []
    const binds: unknown[] = []
    if ('accountId' in patch) {
      sets.push('account_id = ?')
      binds.push(patch.accountId ?? null)
    }
    if ('installationId' in patch) {
      sets.push('installation_id = ?')
      binds.push(patch.installationId ?? null)
    }
    if ('repoGithubId' in patch) {
      sets.push('repo_github_id = ?')
      binds.push(patch.repoGithubId ?? null)
    }
    if (sets.length === 0) return
    binds.push(id)
    await this.db
      .prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run()
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM services WHERE id = ?`).bind(id).run()
  }
}
