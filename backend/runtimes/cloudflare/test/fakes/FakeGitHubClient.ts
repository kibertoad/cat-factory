import type {
  CommitFilesResult,
  GitHubBranch,
  GitHubCheckRun,
  GitHubClient,
  GitHubCodeSearchHit,
  GitHubCommit,
  GitHubIssue,
  GitHubIssueDetail,
  GitHubIssueSearchHit,
  GitHubPullRequest,
  GitHubRepo,
  GitHubRepoRef,
  InstallationMeta,
  InstallationSummary,
  ListOptions,
  MergePullRequestInput,
  OpenPullRequestInput,
  Paged,
  RepoContentEntry,
  RepoEntry,
  RepoFileContent,
} from '@cat-factory/kernel'
import type { CommitFilesInput } from '@cat-factory/contracts'

/**
 * Deterministic GitHubClient for integration tests: serves canned data for reads
 * and records write calls for assertions, with no network access. Populate the
 * public arrays before exercising the sync/read paths.
 */
export class FakeGitHubClient implements GitHubClient {
  installation: InstallationMeta = {
    accountLogin: 'acme',
    targetType: 'Organization',
    appId: 'app-default',
  }
  repos: GitHubRepo[] = []
  branches: GitHubBranch[] = []
  /** Root-level entries served by listRootEntries (empty = empty repo). */
  rootEntries: RepoEntry[] = []
  pulls: GitHubPullRequest[] = []
  issues: GitHubIssue[] = []
  commits: GitHubCommit[] = []
  checks: GitHubCheckRun[] = []

  readonly writes: { method: string; ref: GitHubRepoRef; args: unknown }[] = []
  /** Options passed to each listCommits call, for asserting backfill bounds. */
  readonly commitListOpts: (ListOptions & { sha?: string })[] = []

  /** Installations discoverable via the app JWT; populate before exercising the picker. */
  installations: InstallationSummary[] = []

  async getInstallation(): Promise<InstallationMeta> {
    return this.installation
  }

  async listInstallations(): Promise<InstallationSummary[]> {
    return this.installations
  }

  async listInstallationRepos(): Promise<Paged<GitHubRepo>> {
    return { items: this.repos }
  }

  async getRepo(_installationId: number, ref: GitHubRepoRef): Promise<GitHubRepo> {
    const found = this.repos.find((r) => r.owner === ref.owner && r.name === ref.repo)
    if (!found) throw new Error(`FakeGitHubClient: no repo ${ref.owner}/${ref.repo}`)
    return found
  }

  async listBranches(): Promise<Paged<GitHubBranch>> {
    return { items: this.branches }
  }

  async listRootEntries(): Promise<RepoEntry[]> {
    return this.rootEntries
  }

  /**
   * Canned repo files for the fragment-library source flow, keyed by path. Each
   * carries the file `content` and a `sha`; `listDirectory` lists the entries
   * under a dir prefix and `getFileContent` returns one. Populate before syncing.
   */
  files: Record<string, { content: string; sha: string }> = {}

  async listDirectory(
    _installationId: number,
    _ref: GitHubRepoRef,
    path: string,
    _gitRef?: string,
  ): Promise<RepoContentEntry[]> {
    const prefix = path ? `${path.replace(/\/+$/, '')}/` : ''
    return Object.entries(this.files)
      .filter(([p]) => (prefix ? p.startsWith(prefix) : !p.includes('/')))
      .map(([p, f]) => ({
        path: p,
        name: p.split('/').pop() ?? p,
        type: 'file',
        sha: f.sha,
      }))
  }

  async getFileContent(
    _installationId: number,
    _ref: GitHubRepoRef,
    path: string,
    _gitRef?: string,
  ): Promise<RepoFileContent | null> {
    return this.files[path] ?? null
  }

  async listPullRequests(): Promise<Paged<GitHubPullRequest>> {
    return { items: this.pulls }
  }

  async listIssues(): Promise<Paged<GitHubIssue>> {
    return { items: this.issues }
  }

  /** Full issue details served by getIssue, keyed by `owner/repo#number`. */
  issueDetails: Record<string, GitHubIssueDetail> = {}

  async getIssue(
    _installationId: number,
    ref: GitHubRepoRef,
    issueNumber: number,
  ): Promise<GitHubIssueDetail> {
    const found = this.issueDetails[`${ref.owner}/${ref.repo}#${issueNumber}`]
    if (!found) {
      throw new Error(`FakeGitHubClient: no issue ${ref.owner}/${ref.repo}#${issueNumber}`)
    }
    return found
  }

  /** Canned issue-search hits, returned verbatim by searchIssues. */
  issueSearchHits: GitHubIssueSearchHit[] = []
  /** Canned code-search hits, returned verbatim by searchCode. */
  codeSearchHits: GitHubCodeSearchHit[] = []
  /** Records each (installationId, query) the search methods were called with. */
  readonly searchIssuesCalls: { installationId: number; query: string }[] = []
  readonly searchCodeCalls: { installationId: number; query: string }[] = []

  async searchIssues(installationId: number, query: string): Promise<GitHubIssueSearchHit[]> {
    this.searchIssuesCalls.push({ installationId, query })
    return this.issueSearchHits
  }

  async searchCode(installationId: number, query: string): Promise<GitHubCodeSearchHit[]> {
    this.searchCodeCalls.push({ installationId, query })
    return this.codeSearchHits
  }

  async listCommits(
    _installationId: number,
    _ref: GitHubRepoRef,
    opts?: ListOptions & { sha?: string },
  ): Promise<Paged<GitHubCommit>> {
    this.commitListOpts.push(opts ?? {})
    return { items: this.commits }
  }

  async listCheckRuns(): Promise<Paged<GitHubCheckRun>> {
    return { items: this.checks }
  }

  async createBranch(
    _installationId: number,
    ref: GitHubRepoRef,
    name: string,
    fromSha: string,
  ): Promise<void> {
    this.writes.push({ method: 'createBranch', ref, args: { name, fromSha } })
  }

  async commitFiles(
    _installationId: number,
    ref: GitHubRepoRef,
    input: CommitFilesInput,
  ): Promise<CommitFilesResult> {
    this.writes.push({ method: 'commitFiles', ref, args: input })
    return { sha: 'fake-commit-sha' }
  }

  async createIssue(
    _installationId: number,
    ref: GitHubRepoRef,
    input: { title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    this.writes.push({ method: 'createIssue', ref, args: input })
    return { number: 4242, url: `https://github.com/${ref.owner}/${ref.repo}/issues/4242` }
  }

  async openPullRequest(
    _installationId: number,
    ref: GitHubRepoRef,
    input: OpenPullRequestInput,
  ): Promise<GitHubPullRequest> {
    this.writes.push({ method: 'openPullRequest', ref, args: input })
    const repoId =
      this.repos.find((r) => r.owner === ref.owner && r.name === ref.repo)?.githubId ?? 0
    return {
      repoGithubId: repoId,
      number: 1,
      githubId: 9001,
      title: input.title,
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      headSha: null,
      merged: false,
      author: 'acme-bot',
      updatedAt: 0,
      syncedAt: 0,
    }
  }

  async updatePullRequest(
    _installationId: number,
    ref: GitHubRepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string },
  ): Promise<GitHubPullRequest> {
    this.writes.push({ method: 'updatePullRequest', ref, args: { number, patch } })
    const repoId =
      this.repos.find((r) => r.owner === ref.owner && r.name === ref.repo)?.githubId ?? 0
    return {
      repoGithubId: repoId,
      number,
      githubId: 9001,
      title: patch.title ?? 'updated',
      state: patch.state ?? 'open',
      headRef: null,
      baseRef: patch.base ?? null,
      headSha: null,
      merged: false,
      author: 'acme-bot',
      updatedAt: 0,
      syncedAt: 0,
    }
  }

  /** Canned mergeability returned by getPullRequestMergeability (override per test). */
  mergeability: { mergeable: boolean | null; mergeableState: string; headSha: string | null } = {
    mergeable: true,
    mergeableState: 'clean',
    headSha: 'head-sha',
  }

  async getPullRequestMergeability(
    _installationId: number,
    _ref: GitHubRepoRef,
    _number: number,
  ): Promise<{ mergeable: boolean | null; mergeableState: string; headSha: string | null }> {
    return this.mergeability
  }

  async mergePullRequest(
    _installationId: number,
    ref: GitHubRepoRef,
    number: number,
    input?: MergePullRequestInput,
  ): Promise<void> {
    this.writes.push({ method: 'mergePullRequest', ref, args: { number, input } })
  }

  async deleteBranch(_installationId: number, ref: GitHubRepoRef, branch: string): Promise<void> {
    this.writes.push({ method: 'deleteBranch', ref, args: { branch } })
  }

  async comment(
    _installationId: number,
    ref: GitHubRepoRef,
    issueOrPrNumber: number,
    body: string,
  ): Promise<void> {
    this.writes.push({ method: 'comment', ref, args: { issueOrPrNumber, body } })
  }

  async closeIssue(_installationId: number, ref: GitHubRepoRef, number: number): Promise<void> {
    this.writes.push({ method: 'closeIssue', ref, args: { number } })
  }
}
