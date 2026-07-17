import type { GitHubInstallation } from '@cat-factory/kernel'

export interface GitHubInstallationRow {
  installation_id: number
  workspace_id: string
  account_id: string | null
  account_login: string
  target_type: string
  app_id: string | null
  provider: string | null
  cached_token: string | null
  token_expires_at: number | null
  created_at: number
  deleted_at: number | null
}

export function rowToInstallation(row: GitHubInstallationRow): GitHubInstallation {
  return {
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    accountId: row.account_id ?? null,
    accountLogin: row.account_login,
    targetType: row.target_type === 'Organization' ? 'Organization' : 'User',
    appId: row.app_id ?? null,
    provider: row.provider === 'gitlab' ? 'gitlab' : 'github',
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
    account_id: i.accountId,
    account_login: i.accountLogin,
    target_type: i.targetType,
    app_id: i.appId,
    provider: i.provider,
    cached_token: i.cachedToken,
    token_expires_at: i.tokenExpiresAt,
    created_at: i.createdAt,
    deleted_at: i.deletedAt,
  }
}
