import type {
  BlockRepository,
  GitHubClient,
  PrReportPublishResult,
  PrReportTarget,
  PrVerificationReportPublisher,
} from '@cat-factory/kernel'
import { spliceManagedSection } from '@cat-factory/kernel'
import type {
  RepoTarget,
  ResolveRepoOrigin,
  ResolveRepoTarget,
} from '../agents/ContainerAgentExecutor.js'
import { githubRepoOrigin } from '../agents/containerAgentBody.js'

export interface GitHubPrReportPublisherDependencies {
  /**
   * The ENGINE VCS client (`githubClient ?? gitlabEngineClient` in every facade), so a
   * GitLab-only deployment publishes the report onto its merge-request description through
   * the very same call — no provider branch here.
   */
  githubClient: GitHubClient
  /** Resolves the repo (connection + owner/name) the block's work targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's recorded PR ref (number). */
  blockRepository: BlockRepository
  /**
   * Maps a resolved repo to its origin, whose `provider` the report states. Optional, and
   * defaulted the same way every other clone/dispatch path defaults it (`githubRepoOrigin`), so
   * a GitLab deployment injects one builder and the provider is right everywhere at once —
   * rather than this adapter hard-coding `'github'` behind the engine's back.
   */
  resolveRepoOrigin?: ResolveRepoOrigin
}

/**
 * Upserts the engine's verification report onto a block's pull request as a marker-delimited
 * section of the PR description (see `docs/initiatives/pr-verification-report.md`, decision
 * D1: the markers ARE the section's identity, so the write is idempotent across re-runs,
 * retries and replayed durable steps with no persisted state at all).
 *
 * Read-splice-write, in that order, EVERY time: the new body is always computed from the body
 * as it is right now, so a human who edited the description while the run was in flight keeps
 * their edit. An unchanged body short-circuits before the remote write.
 *
 * Scoped to the block's OWN-service pull request. A multi-repo task's peer PRs are a phase-2
 * item on the initiative tracker — reporting the own-service run's evidence onto a peer repo's
 * PR without per-repo composition would be misleading, so it is deliberately not done here.
 */
export class GitHubPrReportPublisher implements PrVerificationReportPublisher {
  constructor(private readonly deps: GitHubPrReportPublisherDependencies) {}

  async resolveTarget(workspaceId: string, blockId: string): Promise<PrReportTarget | null> {
    const resolved = await this.resolve(workspaceId, blockId)
    if (!resolved) return null
    const { number, repo } = resolved
    const origin = (this.deps.resolveRepoOrigin ?? githubRepoOrigin)(repo)
    return { prNumber: number, repo: `${repo.owner}/${repo.name}`, provider: origin.provider }
  }

  /** The PR number + repo a block's report targets, or null when either is unresolved. */
  private async resolve(
    workspaceId: string,
    blockId: string,
  ): Promise<{ number: number; repo: RepoTarget } | null> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    const number = block?.pullRequest?.number
    if (number == null) return null
    const repo = await this.deps.resolveRepoTarget(workspaceId, blockId)
    return repo ? { number, repo } : null
  }

  async publish(
    workspaceId: string,
    blockId: string,
    section: string,
  ): Promise<PrReportPublishResult> {
    // Resolved through the SAME helper as `resolveTarget`, so the two can never disagree about
    // which PR is "the block's". `publish` re-resolves rather than trusting a target handed in:
    // it is a port method other callers may reach directly, and the write must be self-contained.
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    const number = block?.pullRequest?.number
    if (number == null) return { published: false, skipped: 'no_pull_request' }

    const repo = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!repo) return { published: false, skipped: 'no_repo', prNumber: number }

    const ref = { owner: repo.owner, repo: repo.name }
    const gh = this.deps.githubClient
    const current = await gh.getPullRequestBody(repo.installationId, ref, number)
    const next = spliceManagedSection(current, section)
    if (next === (current ?? '')) {
      return { published: false, skipped: 'unchanged', prNumber: number }
    }
    await gh.updatePullRequest(repo.installationId, ref, number, { body: next })
    return { published: true, prNumber: number }
  }
}
