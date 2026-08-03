import {
  type LogFields,
  type Logger,
  type OperationalMetrics,
  describeError,
  noopLogger,
  noopOperationalMetrics,
} from '@cat-factory/kernel'

// The workflow↔container seam's log vocabulary, extracted from `ContainerAgentExecutor` so the
// messages and their rationale live together (and so the executor stays inside its size budget).
//
// This seam was the platform's blindest: the durable driver logs `executionId`, the harness logs
// `jobId`, and the executor that joins them logged NOTHING — so "the run stopped moving" had no
// server-side account of whether the job was ever accepted, by which backend, on which model.

/** The correlation identity of one dispatched container job. */
export interface ContainerJobIds {
  workspaceId?: string
  executionId?: string
  jobId: string
  agentKind?: string
}

/** The bound logger plus the seam's four transitions. */
export interface ContainerJobLog {
  /**
   * The child logger with the ids bound, for a caller that needs to log something else in the
   * same scope (a `runBestEffort` around this dispatch's observability writes). Bound ONCE here
   * rather than re-spread per call, so a nested emit still carries the ids.
   */
  readonly logger: Logger
  /** The job was accepted by its backend and is now the poller's problem. */
  dispatched(fields?: LogFields): void
  /**
   * The dispatch itself threw. Logged and RE-THROWN by the caller — the engine turns this into a
   * failed step, and this line is the only place the resolved model/backend of a job that never
   * existed is recorded.
   */
  dispatchFailed(error: unknown, fields?: LogFields): void
  /**
   * A poll against the job's backend threw. Logged and RE-THROWN by the caller — the durable
   * driver decides whether to retry or fail the step, and without this the transport fault is
   * recorded against no job, backend or run.
   */
  pollFailed(error: unknown, fields?: LogFields): void
  /**
   * One poll of a still-running job. `debug`, deliberately: this fires every few seconds for the
   * whole life of a run, which is precisely what the level table says `info` is not for.
   */
  progress(fields?: LogFields): void
  /** The job reached a terminal state — `info` when it produced work, `warn` when it did not. */
  settled(outcome: 'done' | 'failed', fields?: LogFields): void
}

/**
 * The counters this seam feeds, beside its log lines. A log line answers "why did THIS run
 * stop"; these answer "is dispatch failing more than it was", which no amount of grepping a
 * per-run line can. The eviction kind and the backend kind are bounded values, so they are
 * safe as dimensions — the ids that are not stay on the log line only.
 */
function countFailure(
  metrics: OperationalMetrics,
  fields: LogFields | undefined,
  counter: 'container.dispatch_failed' | 'container.evicted',
): void {
  const kind = fields?.kind ?? fields?.evicted
  metrics.increment(counter, typeof kind === 'string' ? { kind } : {})
}

/**
 * Bind a container job's correlation ids onto `base`. Accepts an absent logger (a facade that
 * wired none, a unit test) and degrades to `noopLogger`, so no call site has to branch; the
 * metrics sink degrades the same way.
 */
export function containerJobLog(
  base: Logger | undefined,
  ids: ContainerJobIds,
  metrics: OperationalMetrics = noopOperationalMetrics,
): ContainerJobLog {
  const logger = (base ?? noopLogger).child({
    ...(ids.workspaceId ? { workspaceId: ids.workspaceId } : {}),
    ...(ids.executionId ? { executionId: ids.executionId } : {}),
    jobId: ids.jobId,
    ...(ids.agentKind ? { agentKind: ids.agentKind } : {}),
    scope: 'container-agent',
  })
  return {
    logger,
    dispatched: (fields) => logger.info('container job dispatched', fields),
    dispatchFailed: (error, fields) => {
      logger.warn('container job dispatch failed', { ...fields, ...describeError(error) })
      countFailure(metrics, fields, 'container.dispatch_failed')
    },
    pollFailed: (error, fields) =>
      logger.warn('container job poll failed', { ...fields, ...describeError(error) }),
    progress: (fields) => logger.debug('container job running', fields),
    settled: (outcome, fields) => {
      if (outcome === 'done') return logger.info('container job completed', fields)
      logger.warn('container job failed', fields)
      // Only an EVICTED failure is counted here. A failed job that ran to completion (no usable
      // output, a red validation) is the platform working — it already shows up as a failed run
      // in the platform aggregates, and counting it as an operational fault would drown the
      // signal this counter exists for: containers dying under the run.
      if (fields?.evicted) countFailure(metrics, fields, 'container.evicted')
    },
  }
}
