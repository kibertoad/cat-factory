import type {
  BootstrapJobHandle,
  BootstrapJobUpdate,
  BootstrapRepoOutcome,
  BootstrapRepoRequest,
  RepoBootstrapper,
  StepSubtasks,
} from '@cat-factory/core'

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
  /** Repo→frame links recorded on success. */
  readonly links: { workspaceId: string; outcome: BootstrapRepoOutcome; blockId: string }[] = []
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

  private readonly requests = new Map<string, BootstrapRepoRequest>()
  private readonly pollCounts = new Map<string, number>()

  async isWorkspaceConnected(): Promise<boolean> {
    return this.connected
  }

  async startBootstrap(request: BootstrapRepoRequest): Promise<BootstrapJobHandle> {
    this.calls.push(request)
    if (this.failWith) throw new Error(this.failWith)
    this.requests.set(request.jobId, request)
    return { workspaceId: request.workspaceId, jobId: request.jobId }
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
    const n = this.pollCounts.get(handle.jobId) ?? 0
    this.pollCounts.set(handle.jobId, n + 1)
    if (n < this.progressScript.length) {
      return { state: 'running', subtasks: this.progressScript[n]! }
    }
    return { state: 'done', outcome: this.outcomeFor(handle.jobId) }
  }

  async stopBootstrap(handle: BootstrapJobHandle): Promise<void> {
    this.stopped.push(handle.jobId)
  }

  async linkRepoToBlock(
    workspaceId: string,
    outcome: BootstrapRepoOutcome,
    blockId: string,
  ): Promise<void> {
    this.links.push({ workspaceId, outcome, blockId })
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
