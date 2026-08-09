import pMap from 'p-map'
import type { BranchProtectionSummary, Clock } from '@cat-factory/kernel'
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
import { assertFound, VcsCapabilityUnsupportedError } from '@cat-factory/kernel'

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

/**
 * How many repositories one preflight probes. Each repo costs one or two live GitHub reads, so
 * an unbounded fan-out on a large installation would both stall the request and burn rate
 * limit. Anything past the cap is COUNTED and reported, never silently dropped.
 */
const DEFAULT_PROTECTION_PROBE_LIMIT = 100

/**
 * How many of those probes are in flight at once, bounded the same way (and for the same
 * reasons) as `GitHubSyncService`'s `REPO_SYNC_CONCURRENCY`: the cap above bounds the TOTAL
 * cost, this bounds the BURST, and the burst is what trips GitHub's secondary (abuse) limits —
 * which answer with a 403 that looks nothing like a rate-limit response. Each probe is up to
 * two reads, so the real peak is 2 × this; workerd's per-request subrequest cap makes an
 * unbounded fan-out fail on the runtime before it even reaches the vendor.
 *
 * Modest on purpose: this is an on-demand operator check, not a hot path, and its own latency
 * matters far less than leaving the installation's rate limit intact for the CI gate and the
 * merger, which share it and are on the critical path of every run.
 */
const PROTECTION_PROBE_CONCURRENCY = 4

/** One repository's default-branch protection posture. */
export interface RepoBranchProtection {
  repoGithubId: number
  owner: string
  name: string
  defaultBranch: string
  protection: BranchProtectionSummary
}

/** The preflight's answer: what was probed, and what could not be. */
export interface BranchProtectionReport {
  /** `unavailable` ⇒ the wired VCS client cannot answer at all; `repos` is then meaningless. */
  capability: 'ok' | 'unavailable'
  repos: RepoBranchProtection[]
  /** Linked repositories left unprobed by the fan-out cap. */
  omittedRepos: number
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

  // ---- security preflight -------------------------------------------------

  /**
   * Probe each linked repository's DEFAULT branch for host-side protection.
   *
   * This is the one control the platform can neither provide nor enforce: branch protection
   * lives on the host and is the only thing standing between a stolen `Contents: write` token
   * and `main` — covering a direct push AND a merge-API call alike
   * (`backend/docs/security-model.md`, checklist item 1). Nothing in-product used to tell an
   * operator it was missing, which is the gap this closes.
   *
   * Deliberately a live read on an explicitly-invoked endpoint rather than a projection column:
   * the projection's `protected` flag is only as fresh as the last sync, and a security report
   * that is quietly stale is worse than none. `capability: 'unavailable'` is returned rather
   * than an empty list when the wired VCS client cannot answer at all, so "nothing to report"
   * never impersonates "everything is protected".
   *
   * Two separate bounds apply, because they guard different failures — see
   * {@link DEFAULT_PROTECTION_PROBE_LIMIT} (total cost) and
   * {@link PROTECTION_PROBE_CONCURRENCY} (burst).
   */
  async checkDefaultBranchProtection(
    workspaceId: string,
    options: { maxRepos?: number; concurrency?: number } = {},
  ): Promise<BranchProtectionReport> {
    const probe = this.deps.githubClient.getBranchProtection
    if (!probe) return { capability: 'unavailable', repos: [], omittedRepos: 0 }

    const all = await this.deps.repoProjectionRepository.list(workspaceId)
    // A provider-routing client advertises the union of what its backing clients implement, so
    // `probe` being present does NOT mean the workspace's own provider can answer: it may route
    // to a client that omits it (GitLab has no branch-protection API). That is the same FACT this
    // method's `capability: 'unavailable'` already states, so the first such refusal reports it
    // rather than failing the request. A workspace has exactly one VCS installation, so every row
    // here routes to the same provider and one refusal settles the whole report.
    //
    // Scoped to this ONE cause on purpose: any other probe failure still belongs to its own row,
    // where `getBranchProtection` reports it per repo. Swallowing more here would let a rate limit
    // or a revoked token read as "your provider doesn't offer this".
    const max = options.maxRepos ?? DEFAULT_PROTECTION_PROBE_LIMIT
    const probed = all.slice(0, max)
    // `pMap` preserves INPUT order, which the surface depends on: a row must not move because
    // its probe happened to be slow.
    let repos: BranchProtectionReport['repos']
    try {
      repos = await pMap(
        probed,
        async (repo) => {
          // The projection can carry no default branch (a repo linked before its first sync). The
          // probe then reports `branch_not_found` against this guess, which is the honest answer:
          // an omitted row would read as one fewer repository to check.
          const defaultBranch = repo.defaultBranch ?? 'main'
          return {
            repoGithubId: repo.githubId,
            owner: repo.owner,
            name: repo.name,
            defaultBranch,
            protection: await probe.call(
              this.deps.githubClient,
              repo.installationId,
              { owner: repo.owner, repo: repo.name },
              defaultBranch,
            ),
          }
        },
        { concurrency: options.concurrency ?? PROTECTION_PROBE_CONCURRENCY },
      )
    } catch (error) {
      if (!(error instanceof VcsCapabilityUnsupportedError)) throw error
      return { capability: 'unavailable', repos: [], omittedRepos: 0 }
    }
    // A cap that silently truncated would read as "these are all your repositories", which on a
    // security report is the same failure as reporting an unprobed repo as protected.
    return { capability: 'ok', repos, omittedRepos: all.length - probed.length }
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
