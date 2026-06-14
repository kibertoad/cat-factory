import type { GitHubCommit } from '@cat-factory/contracts'

export interface GitHubCommitRow {
  repo_github_id: number
  sha: string
  message: string
  author: string | null
  authored_at: number | null
  synced_at: number
}

export function rowToCommit(row: GitHubCommitRow): GitHubCommit {
  return {
    repoGithubId: row.repo_github_id,
    sha: row.sha,
    message: row.message,
    author: row.author,
    authoredAt: row.authored_at,
    syncedAt: row.synced_at,
  }
}

export function commitValues(workspaceId: string, c: GitHubCommit): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    repo_github_id: c.repoGithubId,
    sha: c.sha,
    message: c.message,
    author: c.author,
    authored_at: c.authoredAt,
    synced_at: c.syncedAt,
  }
}
