import type { GitHubInstallation } from '@cat-factory/core'

export interface GitHubInstallationRow {
  installation_id: number
  workspace_id: string
  account_login: string
  target_type: string
  cached_token: string | null
  token_expires_at: number | null
  created_at: number
  deleted_at: number | null
}

export function rowToInstallation(row: GitHubInstallationRow): GitHubInstallation {
  return {
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    accountLogin: row.account_login,
    targetType: row.target_type === 'Organization' ? 'Organization' : 'User',
    cachedToken: row.cached_token,
    tokenExpiresAt: row.token_expires_at,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

export function installationValues(i: GitHubInstallation): Record<string, unknown> {
  return {
    installation_id: i.installationId,
    workspace_id: i.workspaceId,
    account_login: i.accountLogin,
    target_type: i.targetType,
    cached_token: i.cachedToken,
    token_expires_at: i.tokenExpiresAt,
    created_at: i.createdAt,
    deleted_at: i.deletedAt,
  }
}
