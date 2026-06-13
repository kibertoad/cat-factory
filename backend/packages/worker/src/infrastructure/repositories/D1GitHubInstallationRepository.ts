import type { GitHubInstallation, GitHubInstallationRepository } from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'
import {
  type GitHubInstallationRow,
  buildUpsert,
  installationValues,
  rowToInstallation,
} from './github-mappers'

/** D1-backed store of workspace → GitHub App installation bindings (migration 0004). */
export class D1GitHubInstallationRepository implements GitHubInstallationRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByInstallationId(installationId: number): Promise<GitHubInstallation | null> {
    const row = await this.db
      .prepare('SELECT * FROM github_installations WHERE installation_id = ?')
      .bind(installationId)
      .first<GitHubInstallationRow>()
    return row ? rowToInstallation(row) : null
  }

  async getByWorkspace(workspaceId: string): Promise<GitHubInstallation | null> {
    const row = await this.db
      .prepare('SELECT * FROM github_installations WHERE workspace_id = ? AND deleted_at IS NULL')
      .bind(workspaceId)
      .first<GitHubInstallationRow>()
    return row ? rowToInstallation(row) : null
  }

  async listActive(): Promise<GitHubInstallation[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM github_installations WHERE deleted_at IS NULL')
      .all<GitHubInstallationRow>()
    return results.map(rowToInstallation)
  }

  async upsert(installation: GitHubInstallation): Promise<void> {
    const { sql, binds } = buildUpsert('github_installations', installationValues(installation), [
      'installation_id',
    ])
    await this.db
      .prepare(sql)
      .bind(...binds)
      .run()
  }

  async updateCachedToken(installationId: number, token: string, expiresAt: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE github_installations SET cached_token = ?, token_expires_at = ? WHERE installation_id = ?',
      )
      .bind(token, expiresAt, installationId)
      .run()
  }

  async softDelete(installationId: number, at: number): Promise<void> {
    await this.db
      .prepare('UPDATE github_installations SET deleted_at = ? WHERE installation_id = ?')
      .bind(at, installationId)
      .run()
  }
}
