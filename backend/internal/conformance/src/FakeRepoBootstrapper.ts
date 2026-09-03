import type {
  BootstrapJobHandle,
  BootstrapJobUpdate,
  BootstrapRepoOutcome,
  BootstrapRepoRequest,
  MonorepoTargetRepo,
  RepoBootstrapper,
  StepSubtasks,
} from '@cat-factory/kernel'

/**
 * Deterministic RepoBootstrapper for integration tests: records each dispatch and
 * drives a scripted async lifecycle, so the bootstrap orchestration (dispatch →
 * poll → finalise + board frame) can be exercised without GitHub or a real
 * container. `pollBootstrap` emits each entry of `progressScript` as a running
 * update (one per poll) and then reports `done` (or `failPollWith` → failed).
 */
export class FakeRepoBootstrapper implements RepoBootstrapper {
  /** Dispatch requests, in order. */
  readonly calls: BootstrapRepoRequest[] = []
  /** Repos projected on success (the caller binds the frame's Service to them). */
  readonly projected: { workspaceId: string; outcome: BootstrapRepoOutcome }[] = []
  /** Deterministic github id handed back per projected repo (owner/name → id). */
  private nextGithubId = 9000
  /** Job ids whose container was asked to stop (the failure-cleanup path). */
  readonly stopped: string[] = []
  /** When set, `startBootstrap` throws (pre-flight failure path — fails fast). */
  failWith: string | null = null
  /** When set, the run reports `failed` on poll (container-run failure path). */
  failPollWith: string | null = null
  /** Subtask snapshots to emit (one per running poll) before the terminal outcome. */
  progressScript: StepSubtasks[] = []
  /** Whether the workspace reports as connected (the pre-flight check); on by default. */
  connected = true
  /**
   * Report a completed `pull_request` run with no pull request (the "delivered nowhere" case).
   * Ignored by a `direct_push` run, which never reports one.
   */
  omitPrUrl = false
  /**
   * The repos this workspace projects, by numeric id: what a monorepo target may name. Empty by
   * default, so a suite that has not declared one exercises the refusal rather than accidentally
   * resolving anything it asks for.
   */
  readonly monorepoRepos = new Map<number, MonorepoTargetRepo>()
  /** Repo ids `markRepoAsMonorepo` marked, in order (empty when a pre-flight refused first). */
  readonly markedMonorepo: number[] = []

  private readonly requests = new Map<string, BootstrapRepoRequest>()
  private readonly pollCounts = new Map<string, number>()

  async isWorkspaceConnected(): Promise<boolean> {
    return this.connected
  }

  async resolveMonorepoTarget(
    _workspaceId: string,
    repoGithubId: number,
  ): Promise<MonorepoTargetRepo | null> {
    return this.monorepoRepos.get(repoGithubId) ?? null
  }

  async markRepoAsMonorepo(_workspaceId: string, repoGithubId: number): Promise<void> {
    this.markedMonorepo.push(repoGithubId)
  }

  async startBootstrap(request: BootstrapRepoRequest): Promise<BootstrapJobHandle> {
    this.calls.push(request)
    if (this.failWith) throw new Error(this.failWith)
    // Keyed by the CONTAINER job id, which is what a poll addresses: a monorepo run's apply
    // phase dispatches under its own key, and keying on the run id here would let a fake
    // apply-phase poll silently answer with the survey drive's scripted outcome.
    this.requests.set(request.containerJobId, request)
    return {
      workspaceId: request.workspaceId,
      jobId: request.jobId,
      containerJobId: request.containerJobId,
    }
  }

  async pollBootstrap(handle: BootstrapJobHandle): Promise<BootstrapJobUpdate> {
    if (this.failPollWith) {
      // A poll-time failure models the run faulting (agent / push), so classify it
      // accordingly and carry the detail through, mirroring ContainerRepoBootstrapper.
      return {
        state: 'failed',
        error: this.failPollWith,
        failureKind: 'agent',
        detail: this.failPollWith,
      }
    }
    const n = this.pollCounts.get(handle.containerJobId) ?? 0
    this.pollCounts.set(handle.containerJobId, n + 1)
    if (n < this.progressScript.length) {
      return { state: 'running', subtasks: this.progressScript[n]! }
    }
    const request = this.requests.get(handle.containerJobId)
    // A `pull_request` run's product is the pull request, so the fake reports one: the
    // orchestration FAILS a completed run of that delivery which reports none, and a fake that
    // never answered with a PR could not exercise either side of that. A `direct_push` run
    // reports none, which is the ordinary state of that delivery rather than a failure.
    const pr =
      request?.delivery.mode === 'pull_request' && !this.omitPrUrl
        ? { prUrl: this.prUrlFor(request) }
        : {}
    // A monorepo run created no repository, so it names none; every other run did.
    if (request?.monorepo) return { state: 'done', ...pr }
    return { state: 'done', outcome: this.outcomeFor(handle.containerJobId), ...pr }
  }

  /** The pull request the fake reports, on whichever repository the run wrote to. */
  private prUrlFor(request: BootstrapRepoRequest): string {
    const repo = request.monorepo
      ? `${request.monorepo.owner}/${request.monorepo.name}`
      : `acme/${request.target.name}`
    return `https://github.com/${repo}/pull/7`
  }

  async stopBootstrap(handle: BootstrapJobHandle): Promise<void> {
    this.stopped.push(handle.containerJobId)
  }

  async projectBootstrappedRepo(
    workspaceId: string,
    outcome: BootstrapRepoOutcome,
  ): Promise<{ installationId: number; githubId: number }> {
    this.projected.push({ workspaceId, outcome })
    return { installationId: 1, githubId: this.nextGithubId++ }
  }

  private outcomeFor(jobId: string): BootstrapRepoOutcome {
    const name = this.requests.get(jobId)?.target.name ?? 'bootstrapped'
    return {
      repoUrl: `https://github.com/acme/${name}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
    }
  }
}
