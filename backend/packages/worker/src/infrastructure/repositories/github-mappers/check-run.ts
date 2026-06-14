import type { GitHubCheckRun } from '@cat-factory/contracts'

export interface GitHubCheckRunRow {
  repo_github_id: number
  github_id: number
  head_sha: string
  name: string
  status: string
  conclusion: string | null
  synced_at: number
}

export function rowToCheckRun(row: GitHubCheckRunRow): GitHubCheckRun {
  return {
    repoGithubId: row.repo_github_id,
    githubId: row.github_id,
    headSha: row.head_sha,
    name: row.name,
    status: row.status,
    conclusion: row.conclusion,
    syncedAt: row.synced_at,
  }
}

export function checkRunValues(workspaceId: string, c: GitHubCheckRun): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    repo_github_id: c.repoGithubId,
    github_id: c.githubId,
    head_sha: c.headSha,
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
    synced_at: c.syncedAt,
  }
}
