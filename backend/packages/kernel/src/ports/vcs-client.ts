import type {
  CommitFilesInput,
  GitHubBranch,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  MergePullRequestInput,
  OpenedPullRequest,
  OpenPullRequestInput,
} from '../domain/types.js'
import type { VcsConnectionRef, VcsRepoRef } from '../domain/vcs-types.js'
// The supporting value-shaped interfaces are provider-neutral already (a page of
// results, a directory entry, a review thread, …), so the neutral client reuses them
// from the GitHub port rather than re-declaring them. Phase 1 of the VCS-abstraction
// work folds the GitHub-named entity types (GitHubRepo, …) into neutral names too;
// until then they are reused as-is (their shapes are not GitHub-specific).
import type {
  CommitFilesResult,
  CreateReviewInput,
  CreateReviewResult,
  GitHubChangedFile,
  GitHubCodeSearchHit,
  GitHubIssueComment,
  GitHubIssueDetail,
  GitHubIssueSearchHit,
  GitHubPullRequestComment,
  GitHubPullRequestReview,
  GitHubReviewThread,
  GitHubSubIssue,
  ListOptions,
  Paged,
  RepoContentEntry,
  RepoEntry,
  RepoFileContent,
} from './github-client.js'

export type {
  CommitFilesResult,
  GitHubChangedFile,
  GitHubCodeSearchHit,
  GitHubIssueComment,
  GitHubIssueDetail,
  GitHubIssueSearchHit,
  GitHubPullRequestComment,
  GitHubPullRequestReview,
  GitHubReviewThread,
  GitHubSubIssue,
  ListOptions,
  Paged,
  RepoContentEntry,
  RepoEntry,
  RepoFileContent,
}

// ---------------------------------------------------------------------------
// VcsClient port: the provider-neutral slice of a VCS host's API the integration
// needs (repo/branch/PR/issue/CI reads + writes), expressed as a domain interface so
// the core never imports an HTTP client. Each concrete provider (`github`, `gitlab`)
// ships an adapter, registered in the VCS provider registry (`vcs-registry.ts`) and
// resolved through the {@link VcsConnectionRef} a caller holds.
//
// This is the neutral successor to `GitHubClient`: every method is keyed by a
// `VcsConnectionRef` (which connection's credentials to use) plus a `VcsRepoRef`
// (which repo), instead of GitHub's `installationId: number` + `{ owner, repo }`.
// Optional (`?`) methods may be omitted by a provider that lacks the native concept
// (e.g. GitLab has no GitHub-style sub-issues); the caller degrades gracefully.
// ---------------------------------------------------------------------------

export interface VcsClient {
  // ---- reads --------------------------------------------------------------
  /** List every repository the connection can access (for backfill/reconcile). */
  listRepos(connection: VcsConnectionRef): Promise<Paged<GitHubRepo>>
  getRepo(connection: VcsConnectionRef, ref: VcsRepoRef): Promise<GitHubRepo>
  /** Whether the connection actually has push (write) access to a repo. */
  canPush(connection: VcsConnectionRef, ref: VcsRepoRef): Promise<boolean>
  listBranches(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    etag?: string,
  ): Promise<Paged<GitHubBranch>>
  /** Resolve a single branch's head commit sha, or null when the branch does not exist. */
  branchHeadSha(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    branch: string,
  ): Promise<string | null>
  /** List a repository's root-level entries (empty array for an empty repository). */
  listRootEntries(connection: VcsConnectionRef, ref: VcsRepoRef): Promise<RepoEntry[]>
  /** List a directory's entries on a ref, each with its blob/tree sha. */
  listDirectory(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<RepoContentEntry[]>
  /**
   * List a repository's ENTIRE tree on a ref recursively (in as few calls as the
   * provider allows), so a caller can search files by path without an N+1 walk. Every
   * entry carries its full, repo-root-relative `path` and `type`. `[]` for an empty
   * repo / unknown ref; a very large tree may be truncated (best-effort).
   */
  listTree(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    gitRef?: string,
  ): Promise<RepoContentEntry[]>
  /** Read a file's decoded UTF-8 content + blob sha on a ref, or null if absent. */
  getFileContent(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<RepoFileContent | null>
  /**
   * The sha of the most recent commit that touched `path` on `gitRef` (the repo's
   * default branch when `gitRef` is omitted or `'HEAD'`), or null when there is no
   * such commit. The lightweight staleness probe the fragment library uses instead of
   * listing the whole directory.
   */
  latestCommitSha(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<string | null>
  listPullRequests(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    opts?: ListOptions,
  ): Promise<Paged<GitHubPullRequest>>
  listIssues(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    opts?: ListOptions,
  ): Promise<Paged<GitHubIssue>>
  /** Fetch a single issue's full content (body + comments) for linking it to a block. */
  getIssue(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    issueNumber: number,
  ): Promise<GitHubIssueDetail>
  /** List an issue's native sub-issues (parent→child). Optional. */
  listSubIssues?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    issueNumber: number,
  ): Promise<GitHubSubIssue[]>
  /**
   * Search issues visible to the connection by free text. `order` overrides the default
   * ranking — `created-asc` sorts oldest-first (the issue-intake pickup order).
   */
  searchIssues(
    connection: VcsConnectionRef,
    query: string,
    limit?: number,
    order?: 'created-asc',
  ): Promise<GitHubIssueSearchHit[]>
  /** Code-search files visible to the connection. */
  searchCode(
    connection: VcsConnectionRef,
    query: string,
    limit?: number,
  ): Promise<GitHubCodeSearchHit[]>
  listCommits(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    opts?: ListOptions & { sha?: string },
  ): Promise<Paged<GitHubCommit>>
  listCheckRuns(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    sha: string,
  ): Promise<Paged<GitHubCheckRun>>
  /** List the logins of a PR's currently-requested reviewers. Optional. */
  listRequestedReviewers?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<string[]>
  /** List a PR's submitted reviews, oldest→newest. Optional. */
  listPullRequestReviews?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<GitHubPullRequestReview[]>
  /** List a PR's general conversation comments, oldest→newest. Optional. */
  listIssueComments?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<GitHubPullRequestComment[]>
  /**
   * The number of approving reviews required before a PR can merge — read from `branch`'s
   * protection (GitHub) or the MR's own approval rule (`number`, GitLab). Optional.
   */
  getRequiredApprovingReviewCount?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    branch: string,
    number?: number,
  ): Promise<number>
  /** The branch a PR actually targets, or null when the PR can't be read. Optional. */
  getPullRequestBaseRef?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<string | null>
  /** The source (head) branch of a PR, or null when the PR can't be read. Optional. */
  getPullRequestHeadRef?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<string | null>
  /** List the files a PR changed (path + stats + patch), for PR-deep-review slicing. Optional. */
  listChangedFiles?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<GitHubChangedFile[]>
  /** List a PR's review threads with resolved state + anchor + comments. Optional. */
  listReviewThreads?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<GitHubReviewThread[]>
  /** Post a reply on a review thread. Optional. */
  replyToReviewThread?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    threadId: string,
    body: string,
  ): Promise<void>
  /** Resolve a review thread. Optional. */
  resolveReviewThread?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    threadId: string,
  ): Promise<void>
  /**
   * Publish a PR review's findings as individual inline comments + a summary (the deep-review
   * "post" resolution), returning a per-comment {@link CreateReviewResult}. Optional.
   */
  createReview?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
    input: CreateReviewInput,
  ): Promise<CreateReviewResult>

  // ---- writes -------------------------------------------------------------
  createBranch(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    name: string,
    fromSha: string,
  ): Promise<void>
  /** Create a commit on a branch (blob → tree → commit → ref). */
  commitFiles(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    input: CommitFilesInput,
  ): Promise<CommitFilesResult>
  /** Create an issue; returns the new issue's number + canonical web URL. */
  createIssue(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    input: { title: string; body: string },
  ): Promise<{ number: number; url: string }>
  /** Close an issue as resolved (idempotent from the caller's view). */
  closeIssue(connection: VcsConnectionRef, ref: VcsRepoRef, number: number): Promise<void>
  openPullRequest(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    input: OpenPullRequestInput,
  ): Promise<OpenedPullRequest>
  updatePullRequest(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string },
  ): Promise<GitHubPullRequest>
  /** Read a PR's lazily-computed mergeability (the gate normalises the result). */
  getPullRequestMergeability(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<{ mergeable: boolean | null; mergeableState: string; headSha: string | null }>
  mergePullRequest(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
    input?: MergePullRequestInput,
  ): Promise<void>
  /** Delete a branch (idempotent: a missing branch is not an error). */
  deleteBranch(connection: VcsConnectionRef, ref: VcsRepoRef, branch: string): Promise<void>
  /** Add a comment to an issue or pull request. */
  comment(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    issueOrPrNumber: number,
    body: string,
  ): Promise<void>
  /** Merge one branch into another server-side; maps to a verdict. */
  mergeBranch(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    input: { base: string; head: string },
  ): Promise<'merged' | 'noop' | 'conflict'>
  /**
   * Bring an open PR's source branch up to date with its target branch server-side, and map
   * the result to the same verdict as {@link mergeBranch}. Optional: the human-testing gate's
   * "pull latest base" action prefers this when present (it's the right primitive for a
   * provider whose only server-side branch-advancing operation is a PR rebase, e.g. GitLab,
   * which has no merge-branch-into-branch endpoint). A provider with a real `mergeBranch`
   * (GitHub) omits it and the gate falls back to `mergeBranch`.
   */
  rebasePullRequest?(
    connection: VcsConnectionRef,
    ref: VcsRepoRef,
    number: number,
  ): Promise<'merged' | 'noop' | 'conflict'>
}
