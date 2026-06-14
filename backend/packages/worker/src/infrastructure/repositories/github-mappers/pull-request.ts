import type { GitHubPullRequest } from '@cat-factory/contracts'
import { bool, intBool } from './serialize'

export interface GitHubPullRequestRow {
  repo_github_id: number
  number: number
  github_id: number
  title: string
  state: string
  head_ref: string | null
  base_ref: string | null
  head_sha: string | null
  merged: number
  author: string | null
  gh_updated_at: number | null
  synced_at: number
}

export function rowToPullRequest(row: GitHubPullRequestRow): GitHubPullRequest {
  return {
    repoGithubId: row.repo_github_id,
    number: row.number,
    githubId: row.github_id,
    title: row.title,
    state: row.state === 'closed' ? 'closed' : 'open',
    headRef: row.head_ref,
    baseRef: row.base_ref,
    headSha: row.head_sha,
    merged: bool(row.merged),
    author: row.author,
    updatedAt: row.gh_updated_at,
    syncedAt: row.synced_at,
  }
}

export function pullRequestValues(
  workspaceId: string,
  p: GitHubPullRequest,
): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    repo_github_id: p.repoGithubId,
    number: p.number,
    github_id: p.githubId,
    title: p.title,
    state: p.state,
    head_ref: p.headRef,
    base_ref: p.baseRef,
    head_sha: p.headSha,
    merged: intBool(p.merged),
    author: p.author,
    gh_updated_at: p.updatedAt,
    synced_at: p.syncedAt,
    deleted_at: null,
  }
}
