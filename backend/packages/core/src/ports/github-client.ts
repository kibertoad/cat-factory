import type {
  CommitFilesInput,
  GitHubBranch,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  MergePullRequestInput,
  OpenPullRequestInput,
} from '../domain/types'

// ---------------------------------------------------------------------------
// GitHubClient port: the narrow slice of the GitHub REST API the integration
// needs, expressed as a domain interface so the core never imports an HTTP
// client. The worker implements it with a thin `fetch` adapter that handles
// GitHub App authentication (installation tokens) and rate-limit accounting;
// tests supply a fake. Every method is keyed by `installationId` (which
// workspace's credentials to use) plus a `{ owner, repo }` reference.
//
// Read methods return projection-shaped entities with `syncedAt` already
// stamped by the adapter, so the sync service can persist them directly.
// ---------------------------------------------------------------------------

export interface GitHubRepoRef {
  owner: string
  repo: string
}

/** A page of results plus the conditional-request ETag and a rate-limit reading. */
export interface Paged<T> {
  items: T[]
  /** ETag to store and replay as `If-None-Match` on the next conditional GET. */
  etag?: string
  /** `true` when GitHub answered 304 Not Modified (items will be empty). */
  notModified?: boolean
  rateLimit?: RateLimitSnapshot
}

/** A single observation of GitHub's rate-limit headers for one call. */
export interface RateLimitSnapshot {
  installationId: number
  /** e.g. 'core' / 'graphql' / 'search'. */
  resource: string
  limit: number | null
  remaining: number | null
  /** When the window resets (epoch ms). */
  resetAt: number | null
  observedAt: number
}

export interface ListOptions {
  /** ISO-8601 lower bound for delta listing (GitHub `since`). */
  since?: string
  /** ETag from a prior response for a conditional request. */
  etag?: string
}

export interface CommitFilesResult {
  /** SHA of the new commit. */
  sha: string
}

/** A single root-level entry of a repository's tree (file or directory). */
export interface RepoEntry {
  /** Path relative to the repo root, e.g. `README.md` or `src`. */
  path: string
  /** GitHub content type: `file` | `dir` | `symlink` | `submodule`. */
  type: string
}

/** Installation metadata captured at connect time (needs the app JWT). */
export interface InstallationMeta {
  accountLogin: string
  targetType: 'Organization' | 'User'
  /**
   * Which configured App owns this installation (ADR 0005). The adapter probes
   * the registered Apps to find the owner, so the binding records the App used
   * for this installation's tokens.
   */
  appId: string
}

/** One installation of the App, as listed via the app JWT (GET /app/installations). */
export interface InstallationSummary {
  installationId: number
  accountLogin: string
  targetType: 'Organization' | 'User'
  /** The installing account's avatar, for display in the connect picker. */
  accountAvatarUrl: string | null
}

export interface GitHubClient {
  // ---- installation-level (app JWT) --------------------------------------
  /** Fetch an installation's account login + type (used by the connect flow). */
  getInstallation(installationId: number): Promise<InstallationMeta>
  /** List every installation of the App (used by the connect discovery picker). */
  listInstallations(): Promise<InstallationSummary[]>
  /** List every repository the installation can access (for backfill/reconcile). */
  listInstallationRepos(installationId: number): Promise<Paged<GitHubRepo>>

  // ---- reads --------------------------------------------------------------
  getRepo(installationId: number, ref: GitHubRepoRef): Promise<GitHubRepo>
  listBranches(
    installationId: number,
    ref: GitHubRepoRef,
    etag?: string,
  ): Promise<Paged<GitHubBranch>>
  /**
   * List a repository's root-level entries. Returns an empty array for an empty
   * repository (GitHub answers 404 with no default branch there). Used by repo
   * bootstrapping to tell an empty/boilerplate-only target from one with real
   * content before it pushes the initial commit.
   */
  listRootEntries(installationId: number, ref: GitHubRepoRef): Promise<RepoEntry[]>
  listPullRequests(
    installationId: number,
    ref: GitHubRepoRef,
    opts?: ListOptions,
  ): Promise<Paged<GitHubPullRequest>>
  listIssues(
    installationId: number,
    ref: GitHubRepoRef,
    opts?: ListOptions,
  ): Promise<Paged<GitHubIssue>>
  listCommits(
    installationId: number,
    ref: GitHubRepoRef,
    opts?: ListOptions & { sha?: string },
  ): Promise<Paged<GitHubCommit>>
  listCheckRuns(
    installationId: number,
    ref: GitHubRepoRef,
    sha: string,
  ): Promise<Paged<GitHubCheckRun>>

  // ---- writes -------------------------------------------------------------
  createBranch(
    installationId: number,
    ref: GitHubRepoRef,
    name: string,
    fromSha: string,
  ): Promise<void>
  /** Create a commit on a branch via the Git Data API (blob → tree → commit → ref). */
  commitFiles(
    installationId: number,
    ref: GitHubRepoRef,
    input: CommitFilesInput,
  ): Promise<CommitFilesResult>
  openPullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    input: OpenPullRequestInput,
  ): Promise<GitHubPullRequest>
  updatePullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string },
  ): Promise<GitHubPullRequest>
  mergePullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
    input?: MergePullRequestInput,
  ): Promise<void>
  /** Add a comment to an issue or pull request (they share the issue-comment API). */
  comment(
    installationId: number,
    ref: GitHubRepoRef,
    issueOrPrNumber: number,
    body: string,
  ): Promise<void>
}
