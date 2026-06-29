import type {
  EnvConfigRepairer,
  EnvConfigRepairHandle,
  EnvConfigRepairRequest,
  EnvConfigRepairUpdate,
  StepSubtasks,
} from '@cat-factory/kernel'

/**
 * Deterministic EnvConfigRepairer for integration tests: records each dispatch and drives a
 * scripted async lifecycle, so the env-config-repair orchestration (dispatch → poll →
 * re-validate → finalise) can be exercised without GitHub or a real container. `pollRepair`
 * emits each entry of `progressScript` as a running update (one per poll) and then reports
 * `done` (or `failPollWith` → failed). The post-success re-validation is the service's
 * injected `revalidate` callback (separate from this fake), mirroring production.
 */
export class FakeEnvConfigRepairer implements EnvConfigRepairer {
  /** Dispatch requests, in order. */
  readonly calls: EnvConfigRepairRequest[] = []
  /** Job ids whose container was asked to stop (the failure-cleanup path). */
  readonly stopped: string[] = []
  /** When set, `startRepair` throws (pre-flight failure path — fails fast). */
  failWith: string | null = null
  /** When set, the run reports `failed` on poll (container-run failure path). */
  failPollWith: string | null = null
  /** Subtask snapshots to emit (one per running poll) before the terminal outcome. */
  progressScript: StepSubtasks[] = []

  private readonly pollCounts = new Map<string, number>()

  async startRepair(request: EnvConfigRepairRequest): Promise<EnvConfigRepairHandle> {
    this.calls.push(request)
    if (this.failWith) throw new Error(this.failWith)
    return { workspaceId: request.workspaceId, jobId: request.jobId }
  }

  async pollRepair(handle: EnvConfigRepairHandle): Promise<EnvConfigRepairUpdate> {
    if (this.failPollWith) {
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
    return { state: 'done' }
  }

  async stopRepair(handle: EnvConfigRepairHandle): Promise<void> {
    this.stopped.push(handle.jobId)
  }
}
