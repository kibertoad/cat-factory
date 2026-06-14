import type { GitHubIssue } from '@cat-factory/contracts'

export interface GitHubIssueRow {
  repo_github_id: number
  number: number
  github_id: number
  title: string
  state: string
  author: string | null
  labels: string
  gh_updated_at: number | null
  synced_at: number
}

export function rowToIssue(row: GitHubIssueRow): GitHubIssue {
  return {
    repoGithubId: row.repo_github_id,
    number: row.number,
    githubId: row.github_id,
    title: row.title,
    state: row.state === 'closed' ? 'closed' : 'open',
    author: row.author,
    labels: JSON.parse(row.labels) as string[],
    updatedAt: row.gh_updated_at,
    syncedAt: row.synced_at,
  }
}

export function issueValues(workspaceId: string, i: GitHubIssue): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    repo_github_id: i.repoGithubId,
    number: i.number,
    github_id: i.githubId,
    title: i.title,
    state: i.state,
    author: i.author,
    labels: JSON.stringify(i.labels),
    gh_updated_at: i.updatedAt,
    synced_at: i.syncedAt,
    deleted_at: null,
  }
}
