import type { GitHubBranch } from '@cat-factory/contracts'
import { bool, intBool } from './serialize'

export interface GitHubBranchRow {
  repo_github_id: number
  name: string
  head_sha: string
  protected: number
  synced_at: number
}

export function rowToBranch(row: GitHubBranchRow): GitHubBranch {
  return {
    repoGithubId: row.repo_github_id,
    name: row.name,
    headSha: row.head_sha,
    protected: bool(row.protected),
    syncedAt: row.synced_at,
  }
}

export function branchValues(workspaceId: string, b: GitHubBranch): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    repo_github_id: b.repoGithubId,
    name: b.name,
    head_sha: b.headSha,
    protected: intBool(b.protected),
    synced_at: b.syncedAt,
    deleted_at: null,
  }
}
