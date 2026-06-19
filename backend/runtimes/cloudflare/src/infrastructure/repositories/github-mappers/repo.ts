import type { GitHubRepo } from '@cat-factory/contracts'
import { bool, intBool } from './serialize'

export interface GitHubRepoRow {
  github_id: number
  installation_id: number
  owner: string
  name: string
  default_branch: string | null
  private: number
  block_id: string | null
  synced_at: number
}

export function rowToRepo(row: GitHubRepoRow): GitHubRepo {
  return {
    githubId: row.github_id,
    installationId: row.installation_id,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    private: bool(row.private),
    blockId: row.block_id,
    syncedAt: row.synced_at,
  }
}

export function repoValues(workspaceId: string, r: GitHubRepo): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    github_id: r.githubId,
    installation_id: r.installationId,
    owner: r.owner,
    name: r.name,
    default_branch: r.defaultBranch,
    private: intBool(r.private),
    synced_at: r.syncedAt,
    deleted_at: null,
  }
}
