import type {
  Block,
  BlockRepository,
  GitHubClient,
  Logger,
  PrReportPublishResult,
  PrReportTarget,
  PrVerificationReportPublisher,
  VcsConnectionRef,
} from '@cat-factory/kernel'
import { noopLogger, runBestEffort, spliceManagedSection } from '@cat-factory/kernel'
import { allPullRequests } from '@cat-factory/contracts'
import type {
  RepoTarget,
  ResolveRepoOrigin,
  ResolveRepoTarget,
} from '../agents/ContainerAgentExecutor.js'
import type { ResolveRepoTargets } from '../agents/resolveRepoTarget.js'
import { githubRepoOrigin } from '../agents/containerAgentBody.js'
import { splitRepo } from './repoFullName.js'

export interface GitHubPrReportPublisherDependencies {
  /**
   * The ENGINE VCS client (`githubClient ?? gitlabEngineClient` in every facade), so a
   * GitLab-only deployment publishes the report onto its merge-request description through
   * the very same call — no provider branch here.
   */
  githubClient: GitHubClient
  /** Resolves the repo (connection + owner/name) the block's work targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's recorded PR refs (own-service + peers). */
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

/** One entry of the block's recorded PR set (`allPullRequests`): own-service when `repo` is absent. */
type RecordedPullRequest = ReturnType<typeof allPullRequests>[number]

/**
 * The numeric connection handle the engine VCS client takes, recovered from a target's neutral
 * {@link VcsConnectionRef}.
 *
 * Not kernel's `githubInstallationId`, which refuses a non-GitHub connection: this adapter serves
 * a GitLab deployment too (through `vcsBackedGitHubClient`), and there the same numeric id is the
 * workspace's `github_installations` row that holds its PAT. A non-numeric id is a wiring bug and
 * throws, which the engine records as a failed publish rather than a run failure.
 */
function connectionId(connection: VcsConnectionRef): number {
  const id = Number(connection.connectionId)
  if (!Number.isInteger(id)) {
    throw new Error(
      `PR report target carries an unusable connection id "${connection.connectionId}".`,
    )
  }
  return id
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
 * from a peer's copy rather than copied onto it.
 *
 * **All addressing happens in {@link resolveTargets}, once.** Each target it returns carries the
 * connection and repo its write needs, so `publish` reads no repository and a run with N pull
 * requests costs one resolution per settlement rather than N. That also removes the question
 * `publish` would otherwise have to answer on every call ("is this still the block's PR?") on a
 * hook that fires on every settled step.
 */
export class GitHubPrReportPublisher implements PrVerificationReportPublisher {
  constructor(private readonly deps: GitHubPrReportPublisherDependencies) {}

  /**
   * Every pull request of the block's run, own-service first, each addressed for writing.
   *
   * ONE block read and ONE repo resolution for the whole set: the own-service target is
   * resolved first (it is needed regardless, and lets the multi-repo resolver skip re-walking
   * the block's ancestry), then a single `resolveRepoTargets` call covers every peer. Resolving
   * per recorded peer PR would be the N+1 this codebase bans.
   */
  async resolveTargets(workspaceId: string, blockId: string): Promise<PrReportTarget[]> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block) return []

    // `allPullRequests` is the single source of truth for "every PR this task opened", own
    // first then peers — the same enumeration the CI gate aggregates over. The own-service
    // entry is the one carrying no `repo` (its repo is the task's own service).
    const prs = allPullRequests(block)
    if (prs.length === 0) return []

    const targets: PrReportTarget[] = []
    // The own-service PR FIRST when it exists: the engine reads the peer reports' back-pointer
    // off the head of this list rather than re-resolving it. Matched on an ABSENT `repo` rather
    // than a falsy one, and only when the block records an own PR at all: a peer whose recorded
    // repo is the empty string is unaddressable, not the own-service one.
    const own = block.pullRequest ? prs.find((pr) => pr.repo === undefined) : undefined
    const ownRepo = own ? await this.deps.resolveRepoTarget(workspaceId, blockId) : null
    if (own?.ref.number != null && ownRepo) {
      targets.push(this.describe(ownRepo, own.ref.number, { role: 'own', url: own.ref.url }))
    }
    // BEST-EFFORT, and deliberately so: the multi-repo resolver THROWS on a workspace with no
    // installation or an involved frame that lost its repo linkage, and letting that propagate
    // would mean one broken peer linkage costs the OWN-SERVICE report too — the one a reviewer is
    // most likely reading. The same "a failure on one target does not cost the others" rule the
    // engine applies when publishing, applied one step earlier where the targets are found.
    const peers = await runBestEffort(
      this.deps.logger ?? noopLogger,
      'pr-report peer target resolution',
      () => this.peerTargets(workspaceId, blockId, block, prs, ownRepo),
      { workspaceId, blockId },
    )
    targets.push(...(peers ?? []))
    return targets
  }

  /**
   * The run's PEER pull requests, addressed through the multi-repo repo resolution.
   *
   * A recorded peer PR is only targetable when two things line up: it carries a `number` (the
   * unit the description write addresses, absent on a ref that was only ever a URL) and its
   * repo is in the resolved checkout set (which is what supplies the connection to write
   * through, and is the platform's own answer about which repos this run touched). A peer that
   * satisfies neither is skipped rather than guessed at — the repo name on a recorded peer PR
   * is harness-reported, and writing a report onto a pull request we cannot confirm the identity
   * of is the one failure mode worse than not writing it.
   */
  private async peerTargets(
    workspaceId: string,
    blockId: string,
    block: Block,
    prs: readonly RecordedPullRequest[],
    ownRepo: RepoTarget | null,
  ): Promise<PrReportTarget[]> {
    // Every entry that names a repo: the complement of the own-service one above.
    const peers = prs.filter((pr) => pr.repo !== undefined)
    const resolveAll = this.deps.resolveRepoTargets
    if (!peers.length || !resolveAll) return []

    // The frames to resolve: the task's declared involved services, plus any frame a recorded
    // peer PR attributes itself to. The union rather than either alone, because the declared
    // list is what the run fanned out over while the recorded PRs are what it actually opened,
    // and a peer whose frame left the task's involved list still has an open PR owed a report.
    const frameIds = [
      ...new Set([...(block.involvedServiceIds ?? []), ...peers.flatMap((p) => p.frameIds ?? [])]),
    ]
    const resolved = await resolveAll(workspaceId, blockId, frameIds, ownRepo ?? undefined)
    const byRepo = new Map(
      resolved.checkouts.map((c) => [`${c.target.owner}/${c.target.name}`, c.target]),
    )

    const out: PrReportTarget[] = []
    for (const peer of peers) {
      const number = peer.ref.number
      const repo = peer.repo ? byRepo.get(peer.repo) : undefined
      if (number == null || !repo) continue
      out.push(
        this.describe(repo, number, { role: 'peer', frameIds: peer.frameIds, url: peer.ref.url }),
      )
    }
    return out
  }

  /**
   * A resolved repo + PR number as a self-describing target: which PR, in which repo, on which
   * provider, through which connection.
   *
   * The connection names the DEPLOYMENT'S provider, not this class's name: a GitLab deployment
   * reaches this adapter through `vcsBackedGitHubClient`, and a target that claimed `github`
   * would mis-route the day a native GitLab publisher selects its adapter from it. Both providers
   * ride the same numeric connection id, because a GitLab workspace's PAT connect reuses the
   * `github_installations` row this id comes from.
   */
  private describe(
    repo: RepoTarget,
    prNumber: number,
    scope: { role: 'own' | 'peer'; frameIds?: string[]; url?: string | null },
  ): PrReportTarget {
    const origin = (this.deps.resolveRepoOrigin ?? githubRepoOrigin)(repo)
    return {
      prNumber,
      repo: `${repo.owner}/${repo.name}`,
      provider: origin.provider,
      connection: { provider: origin.provider, connectionId: String(repo.installationId) },
      role: scope.role,
      ...(scope.frameIds?.length ? { frameIds: scope.frameIds } : {}),
      url: scope.url ?? null,
    }
  }

  async publish(
    _workspaceId: string,
    target: PrReportTarget,
    section: string,
  ): Promise<PrReportPublishResult> {
    // No resolution here at all: the target names its own pull request, repo and connection,
    // and the caller composed `section` for exactly that. See the class doc.
    const installationId = connectionId(target.connection)
    const [owner, name] = splitRepo(target.repo)
    const ref = { owner, repo: name }
    const number = target.prNumber
    const gh = this.deps.githubClient
    const current = await gh.getPullRequestBody(installationId, ref, number)
    const next = spliceManagedSection(current, section)
    if (next === (current ?? '')) {
      return { published: false, skipped: 'unchanged', prNumber: number }
    }
    await gh.updatePullRequest(installationId, ref, number, { body: next })
    return { published: true, prNumber: number }
  }
}
