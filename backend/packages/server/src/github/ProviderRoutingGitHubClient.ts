import type {
  CommitFilesInput,
  CommitFilesResult,
  GitHubBranch,
  GitHubCheckRun,
  GitHubClient,
  GitHubCodeSearchHit,
  GitHubCommit,
  GitHubInstallationRepository,
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
  VcsProvider,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// ProviderRoutingGitHubClient: presents ONE `GitHubClient` to the `github` module
// (installation / sync / service) in a deployment that has BOTH a GitHub App AND
// per-workspace GitLab PAT connections. Every method is keyed by `installationId`
// (which connection's credentials to use), so the router resolves that installation's
// stored `provider` and dispatches to the matching underlying client: the App
// `FetchGitHubClient` for a `github` row, the GitLab-adapted client (a `FetchGitLabClient`
// bridged via `asGitHubClient`) for a `gitlab` row. This keeps `GitHubSyncService` /
// `GitHubInstallationService` and both facades' wiring shape unchanged — the multi-provider
// concern lives entirely behind this one seam (the "provider-routing GitHubClient" design).
//
// It is only used when both providers are configured; a single-provider deployment feeds the
// one client directly, so the router is never in the single-provider hot path.
//
// The two provider-discovery methods that are NOT installation-keyed route to GitHub: the App
// installation picker (`listInstallations`) and the personal-PAT repo reads
// (`listReposForToken` / `getRepoForToken`, keyed by a GitHub user PAT) are GitHub-App-flow
// concepts with no GitLab-PAT analogue. The GitLab connect flow provisions its connection
// through `VcsPatConnectionService`, never `getInstallation`, so a `gitlab` installation is
// only ever reached through installation-keyed reads/writes here.
// ---------------------------------------------------------------------------

export interface ProviderRoutingGitHubClientDependencies {
  /** Resolves an installation id → its stored `provider` (memoised; see below). */
  installations: GitHubInstallationRepository
  /** The App-backed client for `github` installations (absent in a GitLab-only deployment). */
  github?: GitHubClient
  /** The GitLab-adapted client for `gitlab` installations (absent when GitLab connect is off). */
  gitlab?: GitHubClient
}

export class ProviderRoutingGitHubClient implements GitHubClient {
  // An installation's provider is IMMUTABLE for the connection's lifetime: a workspace that
  // reconnects under a different provider gets a different installation id (a real GitHub id vs
  // the GitLab synthetic id), and a GitLab reconnect keeps the same synthetic id + provider. So
  // this is a memo of a fixed identity fact, NOT a cache of mutable domain state — it can never
  // serve a stale value the way the banned homebrew TTL caches can. It exists to keep the
  // per-repo sync loops (which issue many installation-keyed calls for one installation) from
  // re-reading the installation row on every call — the N+1 the router would otherwise add.
  private readonly providerById = new Map<number, VcsProvider>()

  // `listReposForToken` / `getRepoForToken` are optional on the port and only exposed when the
  // GitHub client implements them (the PAT-based fetch adapter does; the GitLab adapter omits
  // them). They are keyed by a GitHub user PAT, not an installation, so they always route to
  // GitHub — a GitLab workspace has no GitHub user token, so `GitHubSyncService` never reaches
  // them for a `gitlab` row.
  readonly listReposForToken?: (token: string) => Promise<Paged<GitHubRepo>>
  readonly getRepoForToken?: (token: string, repoGithubId: number) => Promise<GitHubRepo | null>

  constructor(private readonly deps: ProviderRoutingGitHubClientDependencies) {
    const github = deps.github
    if (github?.listReposForToken) {
      this.listReposForToken = (token) => github.listReposForToken!(token)
    }
    if (github?.getRepoForToken) {
      this.getRepoForToken = (token, repoGithubId) => github.getRepoForToken!(token, repoGithubId)
    }
  }

  private requireGithub(): GitHubClient {
    if (!this.deps.github) throw new Error('No GitHub App client is configured')
    return this.deps.github
  }

  private async providerOf(installationId: number): Promise<VcsProvider> {
    const memo = this.providerById.get(installationId)
    if (memo) return memo
    const row = await this.deps.installations.getByInstallationId(installationId)
    // Unknown installation → treat as GitHub (the legacy/backstop default the projection column
    // also uses), so a call for an id we can't resolve routes to the App client rather than throwing.
    const provider = row?.provider ?? 'github'
    this.providerById.set(installationId, provider)
    return provider
  }

  private async route(installationId: number): Promise<GitHubClient> {
    const provider = await this.providerOf(installationId)
    const client = provider === 'gitlab' ? this.deps.gitlab : this.deps.github
    if (!client) {
      throw new Error(`No ${provider} client is configured for installation ${installationId}`)
    }
    return client
  }

  // ---- installation-level -------------------------------------------------
  async getInstallation(installationId: number): Promise<InstallationMeta> {
    return (await this.route(installationId)).getInstallation(installationId)
  }
  listInstallations(): Promise<InstallationSummary[]> {
    // App-only discovery (the connect picker); GitLab has no installation listing.
    return this.requireGithub().listInstallations()
  }
  async listInstallationRepos(installationId: number): Promise<Paged<GitHubRepo>> {
    return (await this.route(installationId)).listInstallationRepos(installationId)
  }
  async searchInstallationRepos(
    installationId: number,
    query: string,
    opts?: { owner?: string; ownerType?: 'Organization' | 'User'; limit?: number },
  ): Promise<GitHubRepo[]> {
    return (await this.route(installationId)).searchInstallationRepos(installationId, query, opts)
  }

  // ---- reads --------------------------------------------------------------
  async getRepo(installationId: number, ref: GitHubRepoRef): Promise<GitHubRepo> {
    return (await this.route(installationId)).getRepo(installationId, ref)
  }
  async getRepoById(installationId: number, repoGithubId: number): Promise<GitHubRepo | null> {
    return (await this.route(installationId)).getRepoById(installationId, repoGithubId)
  }
  async canPush(installationId: number, ref: GitHubRepoRef): Promise<boolean> {
    return (await this.route(installationId)).canPush(installationId, ref)
  }
  async listBranches(
    installationId: number,
    ref: GitHubRepoRef,
    etag?: string,
  ): Promise<Paged<GitHubBranch>> {
    return (await this.route(installationId)).listBranches(installationId, ref, etag)
  }
  async branchHeadSha(
    installationId: number,
    ref: GitHubRepoRef,
    branch: string,
  ): Promise<string | null> {
    return (await this.route(installationId)).branchHeadSha(installationId, ref, branch)
  }
  async listRootEntries(installationId: number, ref: GitHubRepoRef): Promise<RepoEntry[]> {
    return (await this.route(installationId)).listRootEntries(installationId, ref)
  }
  async listDirectory(
    installationId: number,
    ref: GitHubRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<RepoContentEntry[]> {
    return (await this.route(installationId)).listDirectory(installationId, ref, path, gitRef)
  }
  async listTree(
    installationId: number,
    ref: GitHubRepoRef,
    gitRef?: string,
  ): Promise<RepoContentEntry[]> {
    return (await this.route(installationId)).listTree(installationId, ref, gitRef)
  }
  async getFileContent(
    installationId: number,
    ref: GitHubRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<RepoFileContent | null> {
    return (await this.route(installationId)).getFileContent(installationId, ref, path, gitRef)
  }
  async latestCommitSha(
    installationId: number,
    ref: GitHubRepoRef,
    path: string,
    gitRef?: string,
  ): Promise<string | null> {
    return (await this.route(installationId)).latestCommitSha(installationId, ref, path, gitRef)
  }
  async listPullRequests(
    installationId: number,
    ref: GitHubRepoRef,
    opts?: ListOptions,
  ): Promise<Paged<GitHubPullRequest>> {
    return (await this.route(installationId)).listPullRequests(installationId, ref, opts)
  }
  async listIssues(
    installationId: number,
    ref: GitHubRepoRef,
    opts?: ListOptions,
  ): Promise<Paged<GitHubIssue>> {
    return (await this.route(installationId)).listIssues(installationId, ref, opts)
  }
  async getIssue(
    installationId: number,
    ref: GitHubRepoRef,
    issueNumber: number,
  ): Promise<GitHubIssueDetail> {
    return (await this.route(installationId)).getIssue(installationId, ref, issueNumber)
  }
  async searchIssues(
    installationId: number,
    query: string,
    limit?: number,
    order?: 'created-asc',
    page?: number,
  ): Promise<GitHubIssueSearchHit[]> {
    return (await this.route(installationId)).searchIssues(
      installationId,
      query,
      limit,
      order,
      page,
    )
  }
  async searchCode(
    installationId: number,
    query: string,
    limit?: number,
  ): Promise<GitHubCodeSearchHit[]> {
    return (await this.route(installationId)).searchCode(installationId, query, limit)
  }
  async listCommits(
    installationId: number,
    ref: GitHubRepoRef,
    opts?: ListOptions & { sha?: string },
  ): Promise<Paged<GitHubCommit>> {
    return (await this.route(installationId)).listCommits(installationId, ref, opts)
  }
  async listCheckRuns(
    installationId: number,
    ref: GitHubRepoRef,
    sha: string,
  ): Promise<Paged<GitHubCheckRun>> {
    return (await this.route(installationId)).listCheckRuns(installationId, ref, sha)
  }

  // ---- writes -------------------------------------------------------------
  async createBranch(
    installationId: number,
    ref: GitHubRepoRef,
    name: string,
    fromSha: string,
  ): Promise<void> {
    return (await this.route(installationId)).createBranch(installationId, ref, name, fromSha)
  }
  async commitFiles(
    installationId: number,
    ref: GitHubRepoRef,
    input: CommitFilesInput,
  ): Promise<CommitFilesResult> {
    return (await this.route(installationId)).commitFiles(installationId, ref, input)
  }
  async createIssue(
    installationId: number,
    ref: GitHubRepoRef,
    input: { title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    return (await this.route(installationId)).createIssue(installationId, ref, input)
  }
  async closeIssue(installationId: number, ref: GitHubRepoRef, number: number): Promise<void> {
    return (await this.route(installationId)).closeIssue(installationId, ref, number)
  }
  async openPullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    input: OpenPullRequestInput,
  ): Promise<OpenedPullRequest> {
    return (await this.route(installationId)).openPullRequest(installationId, ref, input)
  }
  async updatePullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string },
  ): Promise<GitHubPullRequest> {
    return (await this.route(installationId)).updatePullRequest(installationId, ref, number, patch)
  }
  async getPullRequestMergeability(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
  ): Promise<{ mergeable: boolean | null; mergeableState: string; headSha: string | null }> {
    return (await this.route(installationId)).getPullRequestMergeability(
      installationId,
      ref,
      number,
    )
  }
  async mergePullRequest(
    installationId: number,
    ref: GitHubRepoRef,
    number: number,
    input?: MergePullRequestInput,
  ): Promise<void> {
    return (await this.route(installationId)).mergePullRequest(installationId, ref, number, input)
  }
  async deleteBranch(installationId: number, ref: GitHubRepoRef, branch: string): Promise<void> {
    return (await this.route(installationId)).deleteBranch(installationId, ref, branch)
  }
  async comment(
    installationId: number,
    ref: GitHubRepoRef,
    issueOrPrNumber: number,
    body: string,
  ): Promise<void> {
    return (await this.route(installationId)).comment(installationId, ref, issueOrPrNumber, body)
  }
  async mergeBranch(
    installationId: number,
    ref: GitHubRepoRef,
    input: { base: string; head: string },
  ): Promise<'merged' | 'noop' | 'conflict'> {
    return (await this.route(installationId)).mergeBranch(installationId, ref, input)
  }
}
