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
    // The installation backing a workspace is either its own direct binding
    // (the connector, or the auth-disabled path where account_id is null) OR one
    // shared via the workspace's account. Prefer the direct binding when both
    // exist. The account match is gated on a non-null account so unrelated
    // null-account dev rows never collide.
    const row = await this.db
      .prepare(
        `SELECT i.* FROM github_installations i
         WHERE i.deleted_at IS NULL AND (
           i.workspace_id = ?1
           OR (i.account_id IS NOT NULL
               AND i.account_id = (SELECT w.account_id FROM workspaces w WHERE w.id = ?1))
         )
         ORDER BY (i.workspace_id = ?1) DESC
         LIMIT 1`,
      )
      .bind(workspaceId)
      .first<GitHubInstallationRow>()
    return row ? rowToInstallation(row) : null
  }

  async listWorkspacesForInstallation(installationId: number): Promise<string[]> {
    // The connector workspace, plus every workspace in the installation's account.
    const { results } = await this.db
      .prepare(
        `SELECT i.workspace_id AS id
           FROM github_installations i
          WHERE i.installation_id = ?1 AND i.deleted_at IS NULL
          UNION
         SELECT w.id AS id
           FROM workspaces w
          WHERE w.account_id IS NOT NULL AND w.account_id = (
            SELECT i.account_id FROM github_installations i
             WHERE i.installation_id = ?1 AND i.deleted_at IS NULL
          )`,
      )
      .bind(installationId)
      .all<{ id: string }>()
    return results.map((r) => r.id)
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
