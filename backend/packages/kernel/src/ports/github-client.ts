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
} from '../domain/types.js'

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

/** A directory listing entry from the contents API, carrying the blob/tree sha. */
export interface RepoContentEntry {
  /** Path relative to the repo root, e.g. `guidelines/backend.md`. */
  path: string
  /** Base name, e.g. `backend.md`. */
  name: string
  /** `file` | `dir` | `symlink` | `submodule`. */
  type: string
  /** Blob sha (file) or tree sha (dir) — powers the cheap "changed?" check. */
  sha: string
}

/** A single file's decoded UTF-8 content plus its blob sha. */
export interface RepoFileContent {
  content: string
  sha: string
}

/** A single comment on an issue, as returned by {@link GitHubClient.getIssue}. */
export interface GitHubIssueComment {
  /** Commenter login, or '' when unknown. */
  author: string
  /** GitHub-supplied ISO creation timestamp. */
  createdAt: string
  /** Comment body (GitHub Markdown, used as-is). */
  body: string
}

/** A submitted review on a pull request (latest-per-author is reduced by the caller). */
export interface GitHubPullRequestReview {
  /** Reviewer login, or '' when unknown. */
  author: string
  /** Review verdict: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'. */
  state: string
  /** Epoch ms when the review was submitted (0 when unknown). */
  submittedAt: number
  /** The commit sha the review targeted, or null. */
  commitId: string | null
}

/** One review thread (a review-comment conversation) read via GraphQL. */
export interface GitHubReviewThread {
  /** GraphQL node id — used to reply to and resolve the thread. */
  id: string
  /** Whether the thread is marked resolved on GitHub. */
  isResolved: boolean
  /** Repo-relative file path the thread is anchored to, or null. */
  path: string | null
  /** Line the thread is anchored to, or null. */
  line: number | null
  /** The thread's comments, oldest→newest. */
  comments: GitHubReviewThreadComment[]
}

/** One comment within a {@link GitHubReviewThread}. */
export interface GitHubReviewThreadComment {
  /** Author login, or '' when unknown. */
  author: string
  /** Comment body (GitHub Markdown). */
  body: string
  /** Epoch ms when the comment was created (0 when unknown). */
  createdAt: number
}

/** A general (conversation) comment on a pull request, from the issue-comments API. */
export interface GitHubPullRequestComment {
  /** GitHub comment id (as a string). */
  id: string
  /** Author login, or '' when unknown. */
  author: string
  /** Comment body (GitHub Markdown). */
  body: string
  /** Epoch ms when the comment was created (0 when unknown). */
  createdAt: number
}

/**
 * One issue's full content — body + recent comments + metadata — for linking an
 * issue to a board block as agent context. Distinct from the lean
 * {@link GitHubIssue} projection (which omits the body/comments): this is fetched
 * on demand by the task-source provider, never bulk-synced.
 */
export interface GitHubIssueDetail {
  number: number
  title: string
  /** Workflow state, e.g. `open` / `closed`. */
  state: string
  /** Canonical web URL (GitHub `html_url`). */
  url: string
  /** Issue author login, or null when unknown. */
  author: string | null
  /** Assignee login, or null when unassigned. */
  assignee: string | null
  labels: string[]
  /** Issue body (GitHub Markdown). */
  body: string
  /** Comments oldest→newest. */
  comments: GitHubIssueComment[]
  /**
   * The parent issue this issue is a sub-issue of, as `owner/repo#number`, or null when
   * it has no parent. Surfaced for the epic-import tree walk. Optional: an adapter that
   * does not read the sub-issues relationship omits it (treated as null).
   */
  parentRef?: string | null
}

/** A child issue of a parent, from the GitHub sub-issues relationship. */
export interface GitHubSubIssue {
  owner: string
  repo: string
  number: number
  title: string
  /** Workflow state, e.g. `open` / `closed`. */
  state: string
  /** Canonical web URL (GitHub `html_url`). */
  url: string
}

/** A single hit from searching issues across an installation's repos. */
export interface GitHubIssueSearchHit {
  owner: string
  repo: string
  number: number
  title: string
  /** Workflow state, e.g. `open` / `closed`. */
  state: string
  /** Canonical web URL (GitHub `html_url`). */
  url: string
}

/** A single hit from code-searching an installation's repos for a file. */
export interface GitHubCodeSearchHit {
  owner: string
  repo: string
  /** Path relative to the repo root, e.g. `docs/architecture.md`. */
  path: string
  /** Canonical web URL of the file on its default branch. */
  url: string
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
  /**
   * Whether the installation actually has **push (write)** access to a repo. GitHub
   * returns the token's *effective* `permissions` on the repo payload, so a public
   * repo the installation can READ but is not granted (not in the App's selected
   * repositories, or the App lacks `contents:write`) reports `push:false` even though
   * {@link getRepo}/{@link listRootEntries} succeed. Repo bootstrapping pre-flights this
   * so that "the App can see the repo but can't push to it" case fails fast with a
   * clear, actionable error instead of 403-ing deep inside the container's `git push`.
   */
  canPush(installationId: number, ref: GitHubRepoRef): Promise<boolean>
  listBranches(
    installationId: number,
    ref: GitHubRepoRef,
    etag?: string,
  ): Promise<Paged<GitHubBranch>>
  /**
   * Resolve a single branch's head commit sha, or null when the branch does not
   * exist. Unlike {@link listBranches} (a first-page projection for sync), this is an
   * exact per-branch lookup, so it stays correct on repos with more branches than one
   * page — the lookup a pre/post-op uses to decide create-vs-commit on a work branch.
   */
  branchHeadSha(installationId: number, ref: GitHubRepoRef, branch: string): Promise<string | null>
  /**
   * List a repository's root-level entries. Returns an empty array for an empty
   * repository (GitHub answers 404 with no default branch there). Used by repo
   * bootstrapping to tell an empty/boilerplate-only target from one with real
   * content before it pushes the initial commit.
   */
  listRootEntries(installationId: number, ref: GitHubRepoRef): Promise<RepoEntry[]>
  /**
   * List a directory's entries on a ref via the contents API, each with its blob
   * (file) or tree (dir) sha. Returns `[]` for a missing path/empty repo (404).
   * Used by the fragment library to read a repo of Markdown guidelines and detect
   * which files changed since the last sync.
   */
  listDirectory(
    installationId: number,
    ref: GitHubRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<RepoContentEntry[]>
  /** Read a file's decoded UTF-8 content + blob sha on a ref, or null if absent. */
  getFileContent(
    installationId: number,
    ref: GitHubRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<RepoFileContent | null>
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
  /**
   * Fetch a single issue's full content (body + comments) for linking it to a
   * board block as agent context. Throws (GitHubApiError) if the issue or repo
   * is not visible to the installation.
   */
  getIssue(
    installationId: number,
    ref: GitHubRepoRef,
    issueNumber: number,
  ): Promise<GitHubIssueDetail>
  /**
   * List an issue's GitHub-native **sub-issues** (the parent→child relationship),
   * `GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`. Returns `[]` when the
   * issue has none. Used by the epic-import tree walk to pull a parent issue's children
   * in as board tasks. Optional: a client/runtime that does not implement the sub-issues
   * API omits it (the importer then treats the issue as having no children).
   */
  listSubIssues?(
    installationId: number,
    ref: GitHubRepoRef,
    issueNumber: number,
  ): Promise<GitHubSubIssue[]>
  /**
   * Search issues visible to the installation by free text. `query` is the raw
   * GitHub search text; the adapter scopes it to issues (`is:issue`) and bounds
   * the result count. Used by the GitHub-issues task source's search box.
   */
  searchIssues(
    installationId: number,
    query: string,
    limit?: number,
  ): Promise<GitHubIssueSearchHit[]>
  /**
   * Code-search files visible to the installation. `query` is the raw GitHub
   * code-search text and MUST already carry an `org:`/`user:`/`repo:` scope
   * qualifier (GitHub's code-search API rejects unscoped queries); the caller
   * builds it from the installation's account. Used by the GitHub repo-doc
   * document source's search box.
   */
  searchCode(installationId: number, query: string, limit?: number): Promise<GitHubCodeSearchHit[]>
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
  /**
   * List the logins of a PR's currently-requested (assigned) reviewers
   * (`GET /repos/{o}/{r}/pulls/{n}/requested_reviewers`). Optional: a client that does not
   * implement the human-review reads omits it (the gate then treats the PR as having no
   * assigned reviewer). Used by the `human-review` gate.
   */
  listRequestedReviewers?(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<string[]>
  /**
   * List a PR's submitted reviews (`GET /repos/{o}/{r}/pulls/{n}/reviews`), oldest→newest.
   * The caller reduces to the latest review per author. Optional (see {@link listRequestedReviewers}).
   */
  listPullRequestReviews?(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<GitHubPullRequestReview[]>
  /**
   * List a PR's general conversation comments (`GET /repos/{o}/{r}/issues/{n}/comments`),
   * oldest→newest. Optional (see {@link listRequestedReviewers}).
   */
  listIssueComments?(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<GitHubPullRequestComment[]>
  /**
   * Read the number of approving reviews GitHub's branch protection requires on `branch`
   * (`required_pull_request_reviews.required_approving_review_count`). Returns 1 when the
   * setting is unreadable (no protection rule, or the App lacks admin access — both common).
   * Optional (see {@link listRequestedReviewers}).
   */
  getRequiredApprovingReviewCount?(
    installationId: number,
    ref: GitHubRepoRef,
    branch: string,
  ): Promise<number>
  /**
   * List a PR's review threads via GraphQL (`pullRequest.reviewThreads`), with each thread's
   * resolved state, anchor and comments — the precise "addressed?" signal the REST review-
   * comment reads can't give. Optional (see {@link listRequestedReviewers}).
   */
  listReviewThreads?(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<GitHubReviewThread[]>
  /**
   * Post a reply on a review thread (GraphQL `addPullRequestReviewThreadReply`). Optional
   * (see {@link listRequestedReviewers}). Used by the `human-review` gate to acknowledge a
   * thread before resolving it.
   */
  replyToReviewThread?(
    installationId: number,
    ref: GitHubRepoRef,
    threadId: string,
    body: string,
  ): Promise<void>
  /**
   * Resolve a review thread (GraphQL `resolveReviewThread`). Optional (see
   * {@link listRequestedReviewers}). Used by the `human-review` gate after the `fixer`
   * addressed the thread.
   */
  resolveReviewThread?(installationId: number, ref: GitHubRepoRef, threadId: string): Promise<void>

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
  /**
   * Create an issue. Used by the recurring tech-debt pipeline's `tracker` step to
   * file the issue it raises before implementation. Returns the new issue's number
   * and canonical web URL.
   */
  createIssue(
    installationId: number,
    ref: GitHubRepoRef,
    input: { title: string; body: string },
  ): Promise<{ number: number; url: string }>
  /**
   * Close an issue as resolved. Used by issue-tracker writeback when a task's PR
   * merges. PATCHes `/issues/{number}` with `state: 'closed'` and
   * `state_reason: 'completed'`. Idempotent from the caller's view: closing an
   * already-closed issue is not an error.
   */
  closeIssue(installationId: number, ref: GitHubRepoRef, number: number): Promise<void>
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
  /**
   * Read a PR's lazily-computed mergeability. GitHub computes `mergeable` /
   * `mergeable_state` asynchronously, so `mergeable` is `null` until it is ready;
   * `mergeableState === 'dirty'` is its signal that the PR conflicts with its base.
   * `headSha` is the PR head commit (null when the PR can't be read).
   */
  getPullRequestMergeability(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<{ mergeable: boolean | null; mergeableState: string; headSha: string | null }>
  mergePullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
    input?: MergePullRequestInput,
  ): Promise<void>
  /**
   * Delete a branch (`heads/<branch>` ref). Used to tear down a work branch once its
   * PR has merged, so a later re-run of the same task starts fresh from base instead
   * of resuming on already-merged commits (which a squash/rebase merge would otherwise
   * re-introduce, since those commits are not ancestors of base). Idempotent from the
   * caller's view: a missing branch (already deleted) is not an error.
   */
  deleteBranch(installationId: number, ref: GitHubRepoRef, branch: string): Promise<void>
  /** Add a comment to an issue or pull request (they share the issue-comment API). */
  comment(
    installationId: number,
    ref: GitHubRepoRef,
    issueOrPrNumber: number,
    body: string,
  ): Promise<void>
  /**
   * Merge one branch into another via the repo Merges API (`POST /repos/.../merges`),
   * server-side — no checkout. Used by the human-testing gate's "pull latest main into the
   * branch" action: `base` is the branch to merge INTO (the PR head branch), `head` is the
   * branch/sha to merge in (the repo default branch). Maps GitHub's response to a verdict:
   *   - `merged`   — a merge commit was created (201).
   *   - `noop`     — already up to date, nothing to merge (204).
   *   - `conflict` — the merge conflicts (409); the caller escalates to a conflict-resolver.
   */
  mergeBranch(
    installationId: number,
    ref: GitHubRepoRef,
    input: { base: string; head: string },
  ): Promise<'merged' | 'noop' | 'conflict'>
}
