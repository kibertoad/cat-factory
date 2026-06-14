import type {
  CommitFilesResult,
  GitHubBranch,
  GitHubCheckRun,
  GitHubClient,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  GitHubRepoRef,
  InstallationMeta,
  ListOptions,
  MergePullRequestInput,
  OpenPullRequestInput,
  Paged,
} from '@cat-factory/core'
import type { CommitFilesInput } from '@cat-factory/contracts'

/**
 * Deterministic GitHubClient for integration tests: serves canned data for reads
 * and records write calls for assertions, with no network access. Populate the
 * public arrays before exercising the sync/read paths.
 */
export class FakeGitHubClient implements GitHubClient {
  installation: InstallationMeta = { accountLogin: 'acme', targetType: 'Organization' }
  repos: GitHubRepo[] = []
  branches: GitHubBranch[] = []
  pulls: GitHubPullRequest[] = []
  issues: GitHubIssue[] = []
  commits: GitHubCommit[] = []
  checks: GitHubCheckRun[] = []

  readonly writes: { method: string; ref: GitHubRepoRef; args: unknown }[] = []
  /** Options passed to each listCommits call, for asserting backfill bounds. */
  readonly commitListOpts: (ListOptions & { sha?: string })[] = []

  async getInstallation(): Promise<InstallationMeta> {
    return this.installation
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

  async listPullRequests(): Promise<Paged<GitHubPullRequest>> {
    return { items: this.pulls }
  }

  async listIssues(): Promise<Paged<GitHubIssue>> {
    return { items: this.issues }
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

  async mergePullRequest(
    _installationId: number,
    ref: GitHubRepoRef,
    number: number,
    input?: MergePullRequestInput,
  ): Promise<void> {
    this.writes.push({ method: 'mergePullRequest', ref, args: { number, input } })
  }

  async comment(
    _installationId: number,
    ref: GitHubRepoRef,
    issueOrPrNumber: number,
    body: string,
  ): Promise<void> {
    this.writes.push({ method: 'comment', ref, args: { issueOrPrNumber, body } })
  }
}
