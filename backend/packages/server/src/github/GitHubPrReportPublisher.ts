import type {
  Block,
  BlockRepository,
  GitHubClient,
  Logger,
  PrReportPublishResult,
  PrReportTarget,
  PrVerificationReportPublisher,
} from '@cat-factory/kernel'
import { noopLogger, runBestEffort, spliceManagedSection } from '@cat-factory/kernel'
import type {
  RepoTarget,
  ResolveRepoOrigin,
  ResolveRepoTarget,
} from '../agents/ContainerAgentExecutor.js'
import type { ResolveRepoTargets } from '../agents/resolveRepoTarget.js'
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
   * Resolves EVERY repo a multi-repo run touches, in one call, so a peer PR's report can be
   * addressed (its repo's connection is what the write needs). Optional and absent-tolerant:
   * a deployment with the involved-services coding fan-out switched off never opens a peer PR
   * in the first place, so "no peers resolvable" and "no peers" coincide rather than hiding a
   * report that was owed.
   */
  resolveRepoTargets?: ResolveRepoTargets
  /**
   * Maps a resolved repo to its origin, whose `provider` the report states. Optional, and
   * defaulted the same way every other clone/dispatch path defaults it (`githubRepoOrigin`), so
   * a GitLab deployment injects one builder and the provider is right everywhere at once —
   * rather than this adapter hard-coding `'github'` behind the engine's back.
   */
  resolveRepoOrigin?: ResolveRepoOrigin
  /**
   * Optional logger for the one best-effort path here: PEER target resolution, which is
   * swallowed so a broken peer linkage cannot cost the own-service report. Wire it, or that
   * swallow leaves no trace and the peers simply stop getting reports.
   */
  logger?: Logger
}

/** A resolved target paired with the repo identity the write needs (never leaves this module). */
interface AddressedTarget {
  target: PrReportTarget
  repo: RepoTarget
}

/**
 * The block plus its addressable pull requests. The block rides along so a publish that finds
 * no target can say WHICH of the two causes it hit — a run that has opened no pull request yet,
 * or one whose repo linkage is gone — rather than collapsing them into one reason (the report's
 * own "absent and zero must never render the same" rule, applied to its skips).
 */
interface AddressedBlock {
  block: Block | null
  targets: AddressedTarget[]
}

/**
 * Upserts the engine's verification report onto a block's pull requests as a marker-delimited
 * section of each PR description (see `docs/initiatives/pr-verification-report.md`, decision
 * D1: the markers ARE the section's identity, so the write is idempotent across re-runs,
 * retries and replayed durable steps with no persisted state at all).
 *
 * Read-splice-write, in that order, EVERY time: the new body is always computed from the body
 * as it is right now, so a human who edited the description while the run was in flight keeps
 * their edit. An unchanged body short-circuits before the remote write.
 *
 * On a MULTI-REPO run (service-connections phase 3) the task opens one PR per repo it changed,
 * and every one of them is a target: a reviewer on a connected service's PR is looking at part
 * of this change and is as entitled to the run's evidence as one on the own-service PR. The
 * engine composes a distinct report per target — the own-service-only sections are withheld
 * from a peer's copy rather than copied onto it — which is why `publish` takes the target it
 * was composed FOR instead of re-deciding which pull request is "the block's".
 */
export class GitHubPrReportPublisher implements PrVerificationReportPublisher {
  constructor(private readonly deps: GitHubPrReportPublisherDependencies) {}

  async resolveTargets(workspaceId: string, blockId: string): Promise<PrReportTarget[]> {
    return (await this.address(workspaceId, blockId)).targets.map((a) => a.target)
  }

  /**
   * Every pull request of the block's run, paired with the repo identity its write needs.
   *
   * ONE repo resolution for the whole set: the own-service target is resolved first (it is
   * needed regardless and lets the multi-repo resolver skip re-walking the block's ancestry),
   * then a single `resolveRepoTargets` call covers every peer. Resolving per recorded peer PR
   * would be the N+1 this codebase bans, on a path that runs on every settled step.
   */
  private async address(workspaceId: string, blockId: string): Promise<AddressedBlock> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block) return { block: null, targets: [] }

    const out: AddressedTarget[] = []
    // The own-service PR FIRST when it exists: the engine reads the peer reports' back-pointer
    // off the head of this list rather than re-resolving it.
    const ownNumber = block.pullRequest?.number
    const ownRepo =
      ownNumber == null ? null : await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (ownNumber != null && ownRepo) {
      out.push({
        repo: ownRepo,
        target: {
          ...this.describe(ownRepo, ownNumber),
          role: 'own',
          frameId: null,
          url: block.pullRequest?.url ?? null,
        },
      })
    }
    // BEST-EFFORT, and deliberately so: the multi-repo resolver THROWS on a workspace with no
    // installation or an involved frame that lost its repo linkage, and letting that propagate
    // would mean one broken peer linkage costs the OWN-SERVICE report too — the one a reviewer is
    // most likely reading. The same "a failure on one target does not cost the others" rule the
    // engine applies when publishing, applied one step earlier where the targets are found.
    out.push(
      ...((await runBestEffort(
        this.deps.logger ?? noopLogger,
        'pr-report peer target resolution',
        () => this.peers(workspaceId, blockId, block, ownRepo),
        { workspaceId, blockId },
      )) ?? []),
    )
    return { block, targets: out }
  }

  /**
   * The run's PEER pull requests, addressed through the multi-repo repo resolution.
   *
   * A recorded peer PR is only targetable when two things line up: it carries a `number` (the
   * unit the description write addresses, absent on a ref that was only ever a URL) and its
   * repo is in the resolved checkout set (which is what supplies the connection to write
   * through). A peer that satisfies neither is skipped rather than guessed at — writing a
   * report onto a pull request we cannot confirm the identity of is the one failure mode worse
   * than not writing it.
   */
  private async peers(
    workspaceId: string,
    blockId: string,
    block: Block,
    ownRepo: RepoTarget | null,
  ): Promise<AddressedTarget[]> {
    const peers = block.peerPullRequests ?? []
    const resolveAll = this.deps.resolveRepoTargets
    if (!peers.length || !resolveAll) return []

    // The frames to resolve: the task's declared involved services, plus any frame a recorded
    // peer PR attributes itself to. The union rather than either alone, because the declared
    // list is what the run fanned out over while the recorded PRs are what it actually opened,
    // and a peer whose frame left the task's involved list still has an open PR owed a report.
    const frameIds = [
      ...new Set([
        ...(block.involvedServiceIds ?? []),
        ...peers.map((p) => p.frameId).filter((id): id is string => !!id),
      ]),
    ]
    const resolved = await resolveAll(workspaceId, blockId, frameIds, ownRepo ?? undefined)
    const byRepo = new Map(
      resolved.checkouts.map((c) => [`${c.target.owner}/${c.target.name}`, c.target]),
    )

    const out: AddressedTarget[] = []
    for (const peer of peers) {
      const number = peer.ref.number
      const repo = byRepo.get(peer.repo)
      if (number == null || !repo) continue
      out.push({
        repo,
        target: {
          ...this.describe(repo, number),
          role: 'peer',
          frameId: peer.frameId ?? null,
          url: peer.ref.url ?? null,
        },
      })
    }
    return out
  }

  /** The provider-neutral half of a target: which PR, in which repo, on which provider. */
  private describe(
    repo: RepoTarget,
    prNumber: number,
  ): Pick<PrReportTarget, 'prNumber' | 'repo' | 'provider'> {
    const origin = (this.deps.resolveRepoOrigin ?? githubRepoOrigin)(repo)
    return { prNumber, repo: `${repo.owner}/${repo.name}`, provider: origin.provider }
  }

  async publish(
    workspaceId: string,
    blockId: string,
    target: PrReportTarget,
    section: string,
  ): Promise<PrReportPublishResult> {
    // Re-addressed through the SAME helper `resolveTargets` used, so the connection this writes
    // through can never come from a second opinion about which repos the run touched. The caller
    // composed `section` FOR this target, so the match is by identity (repo + number) and a
    // target that is no longer in the set is a skip, never a write onto whatever is nearest.
    const { block, targets } = await this.address(workspaceId, blockId)
    const match = targets.find(
      (a) => a.target.repo === target.repo && a.target.prNumber === target.prNumber,
    )
    if (!match) {
      // The PR the report was composed for is not addressable: either the run has recorded no
      // pull request at all, or it has but the repo behind it no longer resolves. The two call
      // for different fixes, so they are reported as different reasons.
      const anyRecorded =
        block?.pullRequest?.number != null || (block?.peerPullRequests?.length ?? 0) > 0
      return {
        published: false,
        skipped: anyRecorded ? 'no_repo' : 'no_pull_request',
        ...(anyRecorded ? { prNumber: target.prNumber } : {}),
      }
    }

    const { repo } = match
    const number = target.prNumber
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
