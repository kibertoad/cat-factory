import {
  type BlindJobStopOutcome,
  type HarnessCapabilitySupport,
  type LogFields,
  type Logger,
  type OperationalMetrics,
  describeError,
  describeHarnessBodyCapability,
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
  /**
   * The job body carried a capability and the harness's handshake did not confirm it. Reports
   * BOTH non-`supported` answers, because they are different facts needing different reactions
   * and only this seam sees either: `unsupported` is a run about to be refused (a runner image
   * behind the backend), `unknown` is the deployment's own blind spot (an image or a pool control
   * plane that reports nothing, so a blind run cannot be ruled out).
   *
   * A no-op on `supported`, so every dispatch site can call it unconditionally.
   */
  capabilityGap(support: HarnessCapabilitySupport): void
  /**
   * What became of the blind job the refusal tried to stop. The refusal message already tells the
   * run's reader; this is for the OPERATOR, who has the different question: how often does this
   * deployment fail a run and leave the agent running anyway.
   *
   * Only a `stopped` outcome is silent. The other three each mean an agent may still be working
   * against a repository with nobody watching, which is a standing property of the deployment's
   * runner backend rather than a fact about one run, so each is counted under its own dimension.
   */
  blindJobStopped(outcome: BlindJobStopOutcome): void
}

/**
 * The counters this seam feeds, beside its log lines. A log line answers "why did THIS run
 * stop"; these answer "is dispatch failing more than it was", which no amount of grepping a
 * per-run line can.
 *
 * The caller names WHICH field carries the dimension rather than this picking one out of the
 * log fields. Reading `fields.kind ?? fields.evicted` happened to be right only because the
 * dispatch site passes no `evicted` and the settle site passes no `kind` — add `kind` to a
 * settle site's fields (the backend kind is an obvious thing to log there) and `container.evicted`
 * would silently re-dimension from the eviction cause to the runner backend, splitting the series
 * with nothing failing. Both values are bounded enums; the ids that are not stay on the log line.
 */
function countFailure(
  metrics: OperationalMetrics,
  counter: 'container.dispatch_failed' | 'container.evicted',
  kind: unknown,
): void {
  metrics.increment(counter, typeof kind === 'string' ? { kind } : {})
}

/**
 * Report one capability-handshake answer: a line naming the run, and a counter per CAPABILITY so
 * a standing rate is readable per signal. Both are needed and neither substitutes: the line says
 * which run lost its tools, the counter says how much of the fleet is behind.
 *
 * `capability` is the dimension because it is a closed union; the workspace/run/job ids that
 * would be the interesting split are unbounded and stay on the line, per the metrics rule.
 */
function reportCapabilityGap(
  logger: Logger,
  metrics: OperationalMetrics,
  support: HarnessCapabilitySupport,
): void {
  if (support.kind === 'supported') return
  const capabilities = support.kind === 'unsupported' ? support.missing : support.required
  const described = capabilities.map(describeHarnessBodyCapability)
  if (support.kind === 'unsupported') {
    logger.warn('container job refused: runner image cannot serve a declared capability', {
      capabilities,
      described,
    })
  } else {
    logger.warn('container job dispatched without a capability handshake', {
      capabilities,
      described,
    })
  }
  const counter =
    support.kind === 'unsupported'
      ? 'container.capability_unsupported'
      : 'container.capability_unknown'
  for (const capability of capabilities) metrics.increment(counter, { capability })
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
      // The DISPATCH kind (the runner backend asked to serve the job) — a bounded enum.
      countFailure(metrics, 'container.dispatch_failed', fields?.kind)
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
      // signal this counter exists for: containers dying under the run. The dimension is the
      // EVICTION cause, named explicitly so a later `kind` field on this line cannot displace it.
      if (fields?.evicted) countFailure(metrics, 'container.evicted', fields.evicted)
    },
    capabilityGap: (support) => reportCapabilityGap(logger, metrics, support),
    blindJobStopped: (outcome) => {
      if (outcome === 'stopped') return
      logger.warn('refused container job may still be running: the backend could not stop it', {
        outcome,
      })
      // The dimension is the OUTCOME, a closed union of three, because the three need different
      // operator actions: `unsupported` is a runner backend to give a cancel path, `requested` is
      // a pool to go and verify, `failed` is a fault to investigate.
      metrics.increment('container.blind_job_not_stopped', { outcome })
    },
  }
}
