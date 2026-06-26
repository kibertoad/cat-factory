import type {
  ProvisioningSubsystem,
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import type { ProvisioningLogRecorder } from './ProvisioningLogService.js'

// A RunnerTransport decorator that appends a provisioning-log event for every
// spin-up (dispatch) / spin-down (release) attempt and for a poll that detects a
// failure (an eviction / crash) — routine successful polls are deliberately NOT
// logged (they would swamp the high-churn store). Wrapping at the per-workspace
// `resolveTransport` seam in each facade means the underlying transports
// (CloudflareContainerTransport, LocalContainerRunnerTransport, RunnerPoolTransport)
// stay untouched and the logging is identical across runtimes.
//
// `subsystem` is fixed when the wrapper is built (the resolver knows whether it
// produced a per-run container or a self-hosted pool); `ref.runId` is the run
// (execution) the job belongs to and `ref.jobId` is the step's job id.

export interface LoggingRunnerTransportOptions {
  inner: RunnerTransport
  recorder: ProvisioningLogRecorder
  workspaceId: string
  subsystem: ProvisioningSubsystem
  /** The pool's manifest provider id, when the wrapped transport is a runner pool. */
  providerId?: string | null
  /**
   * Shared set of job ids whose `poll-failure` has already been logged, so a job
   * that is re-polled in its terminal `failed` state (a Workflows replay / sweeper
   * re-drive) records ONE row, not one per poll. Owned by the per-facade transport
   * factory closure so it survives this (stateless, per-resolution) wrapper being
   * rebuilt. Absent ⇒ no dedup (every failed poll logs).
   */
  loggedPollFailures?: Set<string>
}

export class LoggingRunnerTransport implements RunnerTransport {
  constructor(private readonly opts: LoggingRunnerTransportOptions) {}

  async dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind = 'agent',
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    try {
      await this.opts.inner.dispatch(ref, spec, kind, options)
      await this.log('dispatch', ref, 'success', null, { kind, ...options })
    } catch (error) {
      // The verbatim transport error ("… dispatch failed (HTTP X): body") IS the
      // diagnostic the operator needs — log it, then rethrow so the engine still
      // classifies the run failure (Part C).
      await this.log('dispatch', ref, 'failure', messageOf(error), { kind, ...options })
      throw error
    }
  }

  async poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    const view = await this.opts.inner.poll(ref)
    if (view.state === 'failed') {
      // De-dupe: a terminal `failed` job re-polled by a replay/re-drive must log its
      // poll-failure only once (see loggedPollFailures).
      const seen = this.opts.loggedPollFailures
      if (!seen || !seen.has(ref.jobId)) {
        seen?.add(ref.jobId)
        await this.log('poll-failure', ref, 'failure', view.error ?? null, null)
      }
    }
    return view
  }

  async release(ref: RunnerJobRef): Promise<void> {
    if (!this.opts.inner.release) return
    try {
      await this.opts.inner.release(ref)
      await this.log('release', ref, 'success', null, null)
    } catch (error) {
      await this.log('release', ref, 'failure', messageOf(error), null)
      throw error
    }
  }

  private async log(
    operation: 'dispatch' | 'release' | 'poll-failure',
    ref: RunnerJobRef,
    outcome: 'success' | 'failure',
    error: string | null,
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    await this.opts.recorder.record({
      workspaceId: this.opts.workspaceId,
      subsystem: this.opts.subsystem,
      operation,
      targetId: ref.jobId,
      providerId: this.opts.providerId ?? null,
      blockId: null,
      executionId: ref.runId,
      outcome,
      error,
      detail: detail && Object.keys(detail).length > 0 ? JSON.stringify(detail) : null,
    })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
