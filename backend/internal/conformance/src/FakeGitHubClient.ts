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
  OpenedPullRequest,
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

  /** Records each (installationId, query, opts) searchInstallationRepos was called with. */
  readonly searchReposCalls: {
    installationId: number
    query: string
    opts?: { owner?: string; ownerType?: 'Organization' | 'User'; limit?: number }
  }[] = []

  async searchInstallationRepos(
    installationId: number,
    query: string,
    opts?: { owner?: string; ownerType?: 'Organization' | 'User'; limit?: number },
  ): Promise<GitHubRepo[]> {
    this.searchReposCalls.push({ installationId, query, opts })
    const q = query.trim().toLowerCase()
    if (!q) return []
    const matched = this.repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
    return matched.slice(0, Math.min(Math.max(opts?.limit ?? 50, 1), 100))
  }

  async getRepo(_installationId: number, ref: GitHubRepoRef): Promise<GitHubRepo> {
    const found = this.repos.find((r) => r.owner === ref.owner && r.name === ref.repo)
    if (!found) throw new Error(`FakeGitHubClient: no repo ${ref.owner}/${ref.repo}`)
    return found
  }

  async getRepoById(_installationId: number, repoGithubId: number): Promise<GitHubRepo | null> {
    return this.repos.find((r) => r.githubId === repoGithubId) ?? null
  }

  /** Push (write) access per `owner/repo`; defaults to true unless overridden. */
  pushable: Record<string, boolean> = {}

  async canPush(_installationId: number, ref: GitHubRepoRef): Promise<boolean> {
    return this.pushable[`${ref.owner}/${ref.repo}`] ?? true
  }

  async listBranches(): Promise<Paged<GitHubBranch>> {
    return { items: this.branches }
  }

  async branchHeadSha(
    _installationId: number,
    _ref: GitHubRepoRef,
    branch: string,
  ): Promise<string | null> {
    return this.branches.find((b) => b.name === branch)?.headSha ?? null
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

  /**
   * Pseudo head-commit sha for the dir, derived from its files' blob shas: any change
   * to a file under the dir (edit/add/remove/rename) yields a new value, mirroring what
   * the real commits API reports after a commit touches the directory. Null for an empty
   * dir (no commit to pin against).
   */
  async latestCommitSha(
    _installationId: number,
    _ref: GitHubRepoRef,
    path: string,
    _gitRef?: string,
  ): Promise<string | null> {
    const prefix = path ? `${path.replace(/\/+$/, '')}/` : ''
    const parts = Object.entries(this.files)
      .filter(([p]) => (prefix ? p.startsWith(prefix) : !p.includes('/')))
      .map(([p, f]) => `${p}:${f.sha}`)
      .sort()
    if (!parts.length) return null
    const joined = parts.join('\n')
    let hash = 0x811c9dc5
    for (let i = 0; i < joined.length; i++) {
      hash ^= joined.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return `commit-${(hash >>> 0).toString(16).padStart(8, '0')}`
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

  async searchIssues(
    installationId: number,
    query: string,
    limit = 20,
    _order?: 'created-asc',
    page = 1,
  ): Promise<GitHubIssueSearchHit[]> {
    this.searchIssuesCalls.push({ installationId, query })
    // Page the canned hits like the real search API so the intake overscan walk terminates.
    const start = (page - 1) * limit
    return this.issueSearchHits.slice(start, start + limit)
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
  ): Promise<OpenedPullRequest> {
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
      url: `https://github.test/${ref.owner}/${ref.repo}/pull/1`,
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

  /** The verdict the next {@link mergeBranch} returns; default a clean merge. */
  mergeBranchOutcome: 'merged' | 'noop' | 'conflict' = 'merged'

  async mergeBranch(
    _installationId: number,
    ref: GitHubRepoRef,
    input: { base: string; head: string },
  ): Promise<'merged' | 'noop' | 'conflict'> {
    this.writes.push({ method: 'mergeBranch', ref, args: { input } })
    return this.mergeBranchOutcome
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
