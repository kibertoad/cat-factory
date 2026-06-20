import type {
  GitHubBranch,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
} from '../domain/types.js'
import type { RateLimitSnapshot } from './github-client.js'

// ---------------------------------------------------------------------------
// Persistence ports for the GitHub integration. The worker implements these
// against D1 (migration 0004); tests can supply in-memory fakes. All projection
// data is scoped by workspace, mirroring the board repositories.
// ---------------------------------------------------------------------------

/**
 * A GitHub App installation binding. An installation is bound to an *account*
 * (migration 0017), so every workspace in that account shares it; `workspaceId`
 * records the workspace that connected it (and is the binding key on the
 * auth-disabled path, where `accountId` is null). The token fields are
 * infrastructure detail (never sent on the wire); they live here so the auth
 * adapter can read/write the cache in the same row.
 */
export interface GitHubInstallation {
  installationId: number
  workspaceId: string
  /** The account this installation is bound to, or null on the auth-disabled path. */
  accountId: string | null
  accountLogin: string
  targetType: 'Organization' | 'User'
  /**
   * Which GitHub App registration owns this installation (ADR 0005). null for
   * rows created before the multi-App tier — treated as the default App. An
   * installation id belongs to exactly one App on GitHub, so this is immutable.
   */
  appId: string | null
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
  /**
   * The installation backing a workspace: its own direct binding, or one shared
   * via its account. Returns null when neither exists or is tombstoned.
   */
  getByWorkspace(workspaceId: string): Promise<GitHubInstallation | null>
  /**
   * Every workspace that an installation's webhooks should fan out to: the
   * connector workspace plus all workspaces in the installation's account.
   */
  listWorkspacesForInstallation(installationId: number): Promise<string[]>
  /** List every live installation across accounts (used by the cron pass). */
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
  /**
   * Flag (or unflag) a projected repo as a monorepo (does not touch other fields).
   * Like {@link RepoProjectionRepository.linkBlock} this is board-owned state that
   * sync preserves rather than overwrites.
   */
  setMonorepo(workspaceId: string, githubId: number, isMonorepo: boolean): Promise<void>
  /** Live repos whose `synced_at` is older than the cutoff, across all workspaces. */
  listStale(olderThanEpochMs: number): Promise<StaleRepoRef[]>
  /**
   * Of the given candidate workspaces, those that currently link this repo — a single
   * (chunked) query backing the sync fan-out (which workspaces a one-per-org fetch must
   * update), instead of one `get` per candidate. Empty input → empty result.
   */
  linkedWorkspaces(repoGithubId: number, candidateWorkspaceIds: string[]): Promise<string[]>
  /**
   * Incremental-sync cursors are keyed by **installation** + repo (not workspace):
   * a repo is fetched from GitHub once per org and the result fanned out to every
   * workspace that links it, so two teams sharing a repo don't each burn an API
   * round-trip. See {@link GitHubSyncService}.
   */
  getCursor(
    installationId: number,
    repoGithubId: number,
    kind: SyncCursorKind,
  ): Promise<SyncCursor | null>
  setCursor(
    installationId: number,
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
  /**
   * Retention: delete commits authored before `epochMs` (exclusive), returning
   * how many were removed. Unlike the other projections this table has no
   * `deleted_at` tombstone and grows step-wise during backfills, so a periodic
   * pass reclaims old rows (the backfill is bounded to the same horizon, so it
   * won't re-fetch what this prunes). Rows with no `authored_at` are kept.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}

export interface CheckRunProjectionRepository {
  upsertMany(workspaceId: string, checks: GitHubCheckRun[]): Promise<void>
  listBySha(workspaceId: string, repoGithubId: number, headSha: string): Promise<GitHubCheckRun[]>
}

export interface RateLimitRepository {
  /** Append one observed rate-limit snapshot (best-effort; never throws fatally). */
  record(snapshot: RateLimitSnapshot): Promise<void>
  /**
   * Retention: delete snapshots observed before `epochMs` (exclusive), returning
   * how many were removed. This is pure operational telemetry whose only consumer
   * cares about recent headroom, so it gets the most aggressive retention window.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
