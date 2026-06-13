import type {
  GitHubBranch,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
} from '../domain/types'
import type { RateLimitSnapshot } from './github-client'

// ---------------------------------------------------------------------------
// Persistence ports for the GitHub integration. The worker implements these
// against D1 (migration 0004); tests can supply in-memory fakes. All projection
// data is scoped by workspace, mirroring the board repositories.
// ---------------------------------------------------------------------------

/**
 * A workspace's GitHub App installation binding, including the cached short-lived
 * installation token. The token fields are infrastructure detail (never sent on
 * the wire); they live here so the auth adapter can read/write the cache in the
 * same row that maps installation → workspace.
 */
export interface GitHubInstallation {
  installationId: number
  workspaceId: string
  accountLogin: string
  targetType: 'Organization' | 'User'
  /** Cached installation access token, or null if none/expired. */
  cachedToken: string | null
  /** Token expiry (epoch ms), or null. */
  tokenExpiresAt: number | null
  createdAt: number
  /** Set when the installation is suspended/uninstalled (tombstone). */
  deletedAt: number | null
}

export interface GitHubInstallationRepository {
  getByInstallationId(installationId: number): Promise<GitHubInstallation | null>
  getByWorkspace(workspaceId: string): Promise<GitHubInstallation | null>
  /** List every live installation across workspaces (used by the cron pass). */
  listActive(): Promise<GitHubInstallation[]>
  upsert(installation: GitHubInstallation): Promise<void>
  updateCachedToken(installationId: number, token: string, expiresAt: number): Promise<void>
  softDelete(installationId: number, at: number): Promise<void>
}

/** Which entity kind a sync cursor tracks for a repo. */
export type SyncCursorKind = 'branches' | 'pulls' | 'issues' | 'commits' | 'checks'

export interface SyncCursor {
  etag: string | null
  lastSyncedAt: number | null
  sinceIso: string | null
}

/** A repo whose projection has gone stale and should be reconciled. */
export interface StaleRepoRef {
  workspaceId: string
  githubId: number
  installationId: number
  owner: string
  name: string
}

export interface RepoProjectionRepository {
  upsertMany(workspaceId: string, repos: GitHubRepo[]): Promise<void>
  list(workspaceId: string): Promise<GitHubRepo[]>
  get(workspaceId: string, githubId: number): Promise<GitHubRepo | null>
  /** Tombstone repos for this installation whose id is not in `seenGithubIds`. */
  tombstoneMissing(
    workspaceId: string,
    installationId: number,
    seenGithubIds: number[],
    at: number,
  ): Promise<void>
  /** Link a projected repo to a board block (does not touch other fields). */
  linkBlock(workspaceId: string, githubId: number, blockId: string | null): Promise<void>
  /** Live repos whose `synced_at` is older than the cutoff, across all workspaces. */
  listStale(olderThanEpochMs: number): Promise<StaleRepoRef[]>
  getCursor(
    workspaceId: string,
    repoGithubId: number,
    kind: SyncCursorKind,
  ): Promise<SyncCursor | null>
  setCursor(
    workspaceId: string,
    repoGithubId: number,
    kind: SyncCursorKind,
    cursor: SyncCursor,
  ): Promise<void>
}

export interface BranchProjectionRepository {
  upsertMany(workspaceId: string, branches: GitHubBranch[]): Promise<void>
  listByRepo(workspaceId: string, repoGithubId: number): Promise<GitHubBranch[]>
}

export interface PullRequestProjectionRepository {
  upsertMany(workspaceId: string, pulls: GitHubPullRequest[]): Promise<void>
  listByRepo(workspaceId: string, repoGithubId: number): Promise<GitHubPullRequest[]>
  listByWorkspace(workspaceId: string): Promise<GitHubPullRequest[]>
}

export interface IssueProjectionRepository {
  upsertMany(workspaceId: string, issues: GitHubIssue[]): Promise<void>
  listByRepo(workspaceId: string, repoGithubId: number): Promise<GitHubIssue[]>
  listByWorkspace(workspaceId: string): Promise<GitHubIssue[]>
}

export interface CommitProjectionRepository {
  upsertMany(workspaceId: string, commits: GitHubCommit[]): Promise<void>
  listByRepo(workspaceId: string, repoGithubId: number, limit?: number): Promise<GitHubCommit[]>
}

export interface CheckRunProjectionRepository {
  upsertMany(workspaceId: string, checks: GitHubCheckRun[]): Promise<void>
  listBySha(workspaceId: string, repoGithubId: number, headSha: string): Promise<GitHubCheckRun[]>
}

export interface RateLimitRepository {
  /** Append one observed rate-limit snapshot (best-effort; never throws fatally). */
  record(snapshot: RateLimitSnapshot): Promise<void>
}
