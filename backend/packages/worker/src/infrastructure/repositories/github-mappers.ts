import type {
  GitHubBranch,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
} from '@cat-factory/contracts'
import type { GitHubInstallation, SyncCursor } from '@cat-factory/core'

// Row <-> entity mapping for the GitHub projection tables (migration 0004),
// mirroring repositories/mappers.ts. SQLite has no boolean type, so flags are
// stored as 0/1; JSON-shaped columns (issue labels) are (de)serialised here.

const bool = (v: number | null): boolean => v === 1
const intBool = (v: boolean): number => (v ? 1 : 0)

// ---- installations --------------------------------------------------------

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

// ---- repos ----------------------------------------------------------------

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

// ---- branches -------------------------------------------------------------

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

// ---- pull requests --------------------------------------------------------

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

// ---- issues ---------------------------------------------------------------

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

// ---- commits --------------------------------------------------------------

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

// ---- check runs -----------------------------------------------------------

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

// ---- sync cursors ---------------------------------------------------------

export interface SyncCursorRow {
  etag: string | null
  last_synced_at: number | null
  since_iso: string | null
}

export function rowToCursor(row: SyncCursorRow): SyncCursor {
  return { etag: row.etag, lastSyncedAt: row.last_synced_at, sinceIso: row.since_iso }
}

// ---- upsert helper --------------------------------------------------------

/**
 * Build an `INSERT … ON CONFLICT(pk) DO UPDATE` statement from a value map.
 * Columns in `conflictColumns` (the primary key) and `excludeFromUpdate` are not
 * overwritten on conflict — the latter protects fields owned elsewhere (e.g. a
 * repo's `block_id` link, set independently of sync).
 */
export function buildUpsert(
  table: string,
  values: Record<string, unknown>,
  conflictColumns: string[],
  excludeFromUpdate: string[] = [],
): { sql: string; binds: unknown[] } {
  const columns = Object.keys(values)
  const placeholders = columns.map(() => '?').join(', ')
  const protectedCols = new Set([...conflictColumns, ...excludeFromUpdate])
  const updates = columns
    .filter((c) => !protectedCols.has(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflictColumns.join(', ')}) DO UPDATE SET ${updates}`
  return { sql, binds: Object.values(values) }
}
