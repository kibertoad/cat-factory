import type { Clock } from '@cat-factory/kernel'
import type { GitHubClient, GitHubRepoRef } from '@cat-factory/kernel'
import type {
  BranchProjectionRepository,
  IssueProjectionRepository,
  PullRequestProjectionRepository,
  RepoProjectionRepository,
} from '@cat-factory/kernel'
import type {
  CommitFilesInput,
  GitHubBranch,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  MergePullRequestInput,
  OpenPullRequestInput,
} from '@cat-factory/kernel'
import { assertFound } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// GitHubService: the read/write facade the API controller uses. Reads are served
// straight from the local projections (fast, rate-limit-free); writes go to
// GitHub via the GitHubClient and opportunistically refresh the affected
// projection rows (the authoritative update still arrives via webhook later).
// Repo references are resolved from the projection by GitHub numeric id.
// ---------------------------------------------------------------------------

export interface GitHubServiceDependencies {
  githubClient: GitHubClient
  repoProjectionRepository: RepoProjectionRepository
  branchProjectionRepository: BranchProjectionRepository
  pullRequestProjectionRepository: PullRequestProjectionRepository
  issueProjectionRepository: IssueProjectionRepository
  clock: Clock
}

interface ResolvedRepo {
  repo: GitHubRepo
  installationId: number
  ref: GitHubRepoRef
}

export class GitHubService {
  constructor(private readonly deps: GitHubServiceDependencies) {}

  // ---- projection reads ---------------------------------------------------

  listRepos(workspaceId: string): Promise<GitHubRepo[]> {
    return this.deps.repoProjectionRepository.list(workspaceId)
  }

  listBranches(workspaceId: string, repoGithubId: number): Promise<GitHubBranch[]> {
    return this.deps.branchProjectionRepository.listByRepo(workspaceId, repoGithubId)
  }

  listPullRequests(workspaceId: string): Promise<GitHubPullRequest[]> {
    return this.deps.pullRequestProjectionRepository.listByWorkspace(workspaceId)
  }

  listIssues(workspaceId: string): Promise<GitHubIssue[]> {
    return this.deps.issueProjectionRepository.listByWorkspace(workspaceId)
  }

  // ---- writes -------------------------------------------------------------

  async createBranch(
    workspaceId: string,
    repoGithubId: number,
    name: string,
    fromSha: string,
  ): Promise<GitHubBranch> {
    const { installationId, ref } = await this.resolve(workspaceId, repoGithubId)
    await this.deps.githubClient.createBranch(installationId, ref, name, fromSha)
    const branch: GitHubBranch = {
      repoGithubId,
      name,
      headSha: fromSha,
      protected: false,
      syncedAt: this.deps.clock.now(),
    }
    await this.deps.branchProjectionRepository.upsertMany(workspaceId, [branch])
    return branch
  }

  async commitFiles(
    workspaceId: string,
    repoGithubId: number,
    input: CommitFilesInput,
  ): Promise<{ sha: string }> {
    const { installationId, ref } = await this.resolve(workspaceId, repoGithubId)
    return this.deps.githubClient.commitFiles(installationId, ref, input)
  }

  async openPullRequest(
    workspaceId: string,
    repoGithubId: number,
    input: OpenPullRequestInput,
  ): Promise<GitHubPullRequest> {
    const { installationId, ref } = await this.resolve(workspaceId, repoGithubId)
    const pr = await this.deps.githubClient.openPullRequest(installationId, ref, input)
    await this.deps.pullRequestProjectionRepository.upsertMany(workspaceId, [pr])
    return pr
  }

  async mergePullRequest(
    workspaceId: string,
    repoGithubId: number,
    number: number,
    input?: MergePullRequestInput,
  ): Promise<void> {
    const { installationId, ref } = await this.resolve(workspaceId, repoGithubId)
    await this.deps.githubClient.mergePullRequest(installationId, ref, number, input)
  }

  async comment(
    workspaceId: string,
    repoGithubId: number,
    issueOrPrNumber: number,
    body: string,
  ): Promise<void> {
    const { installationId, ref } = await this.resolve(workspaceId, repoGithubId)
    await this.deps.githubClient.comment(installationId, ref, issueOrPrNumber, body)
  }

  private async resolve(workspaceId: string, repoGithubId: number): Promise<ResolvedRepo> {
    const repo = assertFound(
      await this.deps.repoProjectionRepository.get(workspaceId, repoGithubId),
      'GitHubRepo',
      String(repoGithubId),
    )
    return {
      repo,
      installationId: repo.installationId,
      ref: { owner: repo.owner, repo: repo.name },
    }
  }
}
