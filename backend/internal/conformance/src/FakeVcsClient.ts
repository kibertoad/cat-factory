import type {
  CommitFilesResult,
  GitHubBranch,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssue,
  GitHubIssueDetail,
  GitHubIssueSearchHit,
  GitHubPullRequest,
  GitHubPullRequestComment,
  GitHubPullRequestReview,
  GitHubRepo,
  GitHubReviewThread,
  OpenedPullRequest,
  Paged,
  RepoContentEntry,
  RepoEntry,
  RepoFileContent,
  VcsClient,
  VcsConnectionRef,
  VcsRepoRef,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// A deterministic, in-memory `VcsClient` for conformance/unit tests. It implements the FULL
// neutral port (so it can be bridged onto the legacy `GitHubClient` via `asGitHubClient` and
// driven through the engine's gate / merge / branch-update seams) with sensible canned data, a
// handful of knobs for the gate-relevant reads, and call recorders for the writes. The point:
// prove a VcsClient-backed (e.g. GitLab) deployment satisfies the same gate contract GitHub does,
// without any network — the provider analogue of `FakeAgentExecutor`.
// ---------------------------------------------------------------------------

export interface FakeVcsClientOptions {
  /** Head commit sha of every branch (the CI gate reads the PR branch's head). */
  headSha?: string
  /** Check runs returned for the head sha (default: one green `build`). */
  checks?: GitHubCheckRun[]
  /** Mergeability verdict (default: cleanly mergeable). */
  mergeability?: { mergeable: boolean | null; mergeableState: string }
  /** Submitted reviews / approvals (default: one APPROVED by `approver`). */
  reviews?: GitHubPullRequestReview[]
  /** Requested reviewers (default: none). */
  requestedReviewers?: string[]
  /** Required approving review count (default: 1). */
  requiredApprovingReviewCount?: number
  /** A PR's base/target branch (default: `main`). */
  baseRef?: string
  /** Review threads (default: none). */
  reviewThreads?: GitHubReviewThread[]
  /** Plain MR/PR conversation comments (default: none) — read on the not-yet-approved path. */
  comments?: GitHubPullRequestComment[]
  /** Outcome of a `rebasePullRequest` call (default: `merged`). */
  rebaseOutcome?: 'merged' | 'noop' | 'conflict'
  /** The repo's default branch (default: `main`). */
  defaultBranch?: string
}

const emptyPaged = <T>(): Paged<T> => ({ items: [] })

/** Records every mutating call so a test can assert "the gate actually merged / rebased". */
export interface FakeVcsCalls {
  merged: number[]
  rebased: number[]
  resolvedThreads: string[]
  comments: { number: number; body: string }[]
}

export class FakeVcsClient implements VcsClient {
  readonly calls: FakeVcsCalls = { merged: [], rebased: [], resolvedThreads: [], comments: [] }
  private readonly o: Required<
    Omit<
      FakeVcsClientOptions,
      'checks' | 'reviews' | 'requestedReviewers' | 'reviewThreads' | 'mergeability' | 'comments'
    >
  > &
    Pick<
      FakeVcsClientOptions,
      'checks' | 'reviews' | 'requestedReviewers' | 'reviewThreads' | 'mergeability' | 'comments'
    >

  constructor(options: FakeVcsClientOptions = {}) {
    this.o = {
      headSha: options.headSha ?? 'headsha',
      requiredApprovingReviewCount: options.requiredApprovingReviewCount ?? 1,
      baseRef: options.baseRef ?? 'main',
      rebaseOutcome: options.rebaseOutcome ?? 'merged',
      defaultBranch: options.defaultBranch ?? 'main',
      checks: options.checks ?? [
        {
          repoGithubId: 1,
          githubId: 1,
          headSha: options.headSha ?? 'headsha',
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          syncedAt: 0,
        },
      ],
      reviews: options.reviews ?? [
        { author: 'approver', state: 'APPROVED', submittedAt: 0, commitId: null },
      ],
      requestedReviewers: options.requestedReviewers ?? [],
      reviewThreads: options.reviewThreads ?? [],
      comments: options.comments,
      mergeability: options.mergeability ?? { mergeable: true, mergeableState: 'clean' },
    }
  }

  // ---- reads the gate / merge / branch-update seams consume ---------------
  async getRepo(_c: VcsConnectionRef, ref: VcsRepoRef): Promise<GitHubRepo> {
    return {
      githubId: 1,
      installationId: 1,
      owner: ref.owner,
      name: ref.repo,
      defaultBranch: this.o.defaultBranch,
      private: true,
      syncedAt: 0,
    } as GitHubRepo
  }
  async branchHeadSha(): Promise<string | null> {
    return this.o.headSha
  }
  async listCommits(): Promise<Paged<GitHubCommit>> {
    return { items: [{ sha: this.o.headSha } as unknown as GitHubCommit] }
  }
  async listCheckRuns(): Promise<Paged<GitHubCheckRun>> {
    return { items: this.o.checks ?? [] }
  }
  async getPullRequestMergeability(): Promise<{
    mergeable: boolean | null
    mergeableState: string
    headSha: string | null
  }> {
    return { ...this.o.mergeability!, headSha: this.o.headSha }
  }
  async listPullRequestReviews(): Promise<GitHubPullRequestReview[]> {
    return this.o.reviews ?? []
  }
  async listRequestedReviewers(): Promise<string[]> {
    return this.o.requestedReviewers ?? []
  }
  async getRequiredApprovingReviewCount(): Promise<number> {
    return this.o.requiredApprovingReviewCount
  }
  async getPullRequestBaseRef(): Promise<string | null> {
    return this.o.baseRef
  }
  async listReviewThreads(): Promise<GitHubReviewThread[]> {
    return this.o.reviewThreads ?? []
  }
  async listIssueComments(): Promise<GitHubPullRequestComment[]> {
    return this.o.comments ?? []
  }

  // ---- writes (recorded) --------------------------------------------------
  async mergePullRequest(_c: VcsConnectionRef, _r: VcsRepoRef, number: number): Promise<void> {
    this.calls.merged.push(number)
  }
  async rebasePullRequest(
    _c: VcsConnectionRef,
    _r: VcsRepoRef,
    number: number,
  ): Promise<'merged' | 'noop' | 'conflict'> {
    this.calls.rebased.push(number)
    return this.o.rebaseOutcome
  }
  async resolveReviewThread(_c: VcsConnectionRef, _r: VcsRepoRef, threadId: string): Promise<void> {
    this.calls.resolvedThreads.push(threadId)
  }
  async replyToReviewThread(): Promise<void> {}
  async comment(_c: VcsConnectionRef, _r: VcsRepoRef, number: number, body: string): Promise<void> {
    this.calls.comments.push({ number, body })
  }
  async mergeBranch(): Promise<'merged' | 'noop' | 'conflict'> {
    return 'merged'
  }

  // ---- remaining VcsClient surface: inert deterministic stubs -------------
  async listRepos(): Promise<Paged<GitHubRepo>> {
    return emptyPaged()
  }
  async canPush(): Promise<boolean> {
    return true
  }
  async listBranches(): Promise<Paged<GitHubBranch>> {
    return emptyPaged()
  }
  async listRootEntries(): Promise<RepoEntry[]> {
    return []
  }
  async listDirectory(): Promise<RepoContentEntry[]> {
    return []
  }
  async getFileContent(): Promise<RepoFileContent | null> {
    return null
  }
  async latestCommitSha(): Promise<string | null> {
    return this.o.headSha
  }
  async listPullRequests(): Promise<Paged<GitHubPullRequest>> {
    return emptyPaged()
  }
  async listIssues(): Promise<Paged<GitHubIssue>> {
    return emptyPaged()
  }
  async getIssue(): Promise<GitHubIssueDetail> {
    return {
      number: 0,
      title: '',
      state: 'open',
      url: '',
      author: null,
      assignee: null,
      labels: [],
      body: '',
      comments: [],
    }
  }
  async searchIssues(): Promise<GitHubIssueSearchHit[]> {
    return []
  }
  async searchCode(): Promise<[]> {
    return []
  }
  async createBranch(): Promise<void> {}
  async commitFiles(): Promise<CommitFilesResult> {
    return { sha: this.o.headSha }
  }
  async createIssue(): Promise<{ number: number; url: string }> {
    return { number: 0, url: '' }
  }
  async closeIssue(): Promise<void> {}
  async openPullRequest(): Promise<OpenedPullRequest> {
    return { number: 1, url: 'https://gitlab.test/mr/1' } as unknown as OpenedPullRequest
  }
  async updatePullRequest(): Promise<GitHubPullRequest> {
    return { number: 1 } as unknown as GitHubPullRequest
  }
  async deleteBranch(): Promise<void> {}
}
