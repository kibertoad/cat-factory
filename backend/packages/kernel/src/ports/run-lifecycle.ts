// The outbound RUN-LIFECYCLE seam: a push telling an external system that a run started or
// reached a terminal state, without it having to poll `GET /api/v1/tasks/:taskId/run`.
//
// The notification webhook next door delivers the cards a HUMAN must resolve. This is the other
// half an integration needs: the ordinary lifecycle of work it queued — the run began, the run
// finished, the run failed — none of which raises a notification at all (a task whose pipeline
// carries a `merger` merges its own PR and settles silently, which is exactly the happy path a CI
// system wants to hear about). Without it, a headless caller's only way to learn that its task
// finished is to keep asking.
//
// The port takes an ALREADY-PROJECTED event rather than an `ExecutionInstance`, for the same
// reason the public API projects: the engine owns what a run means, and a transport must not be
// able to widen what leaves the deployment by reaching for another field. It also keeps this port
// free of any orchestration type, so kernel stays the bottom layer.

/**
 * The lifecycle transitions an external receiver can subscribe to.
 *
 * The three run edges, plus one STEP edge. A per-step PROGRESS feed would be a firehose (the
 * engine emits on every container poll) and is what the SSE endpoints are for; `run.step_completed`
 * is the narrowing of that, not a reversal of it. It fires once per step BOUNDARY, so a ten-step
 * pipeline produces ten deliveries over however many hours it runs rather than one per poll.
 *
 * The boundary is a single seam rather than a hook per settle site: every path that finishes a step
 * and moves the run's cursor funnels through `RunStateMachine`'s `settleStepAndAdvance` (the agent
 * result, a skip, a companion, a one-shot) or `settleAdvancedGate` (a resolved gate). A hook at
 * each of the twelve callers is the drift the run's terminal emit already learned to avoid.
 */
export const RUN_LIFECYCLE_EVENTS = [
  'run.started',
  'run.step_completed',
  'run.completed',
  'run.failed',
] as const
export type RunLifecycleEventKind = (typeof RUN_LIFECYCLE_EVENTS)[number]

/** Whether `value` is one of the known lifecycle events (a lenient decode for a stored filter). */
export function isRunLifecycleEventKind(value: unknown): value is RunLifecycleEventKind {
  return typeof value === 'string' && (RUN_LIFECYCLE_EVENTS as readonly string[]).includes(value)
}

/**
 * The step a `run.step_completed` event is about.
 *
 * `outcome` is what stops a skipped step reading as work that happened: the engine skips a gated
 * step by marking it done with no output, which is byte-for-byte a step that ran and reported
 * nothing, and a receiver counting completed steps would score the two the same. It is the wire
 * twin of `publicRunStep.skipped`, and it says WHETHER rather than WHY for the same reason that
 * field does: which axis skipped a step is a vocabulary the engine grows, and a published enum is
 * a promise not to.
 */
export interface RunLifecycleStep {
  /** Position in the run's own step chain, lined up against `publicRun.steps`. */
  index: number
  /** The step's agent kind (`coder`, `ci`, `merger`, a deployment's own). */
  agentKind: string
  /** `completed` for a step that ran, `skipped` for one the pipeline decided against running. */
  outcome: 'completed' | 'skipped'
  /** Whether this was the run's LAST step, so a receiver can expect a terminal event next. */
  final: boolean
}

/** The failure a `run.failed` event carries — the same record the run row keeps. */
export interface RunLifecycleFailure {
  /** The failure class the engine funnelled this through (e.g. `agent`, `environment`). */
  kind: string
  message: string
  /** Machine-readable cause, when the failing path named one; null when it did not. */
  reason: string | null
}

/**
 * One lifecycle transition, projected for delivery. Small on purpose: it names the run and the
 * task it belongs to, the pipeline that ran, and — on the terminal events — the outcome. A
 * receiver that wants the per-step detail reads `GET /api/v1/tasks/:taskId/run` with the ids
 * carried here.
 */
export interface RunLifecycleEvent {
  event: RunLifecycleEventKind
  runId: string
  /** The board task (block) the run belongs to. */
  taskId: string
  taskTitle: string
  pipelineId: string
  pipelineName: string
  /**
   * Epoch-ms the run started (its `createdAt`), so a receiver can measure duration itself. NULL
   * when the run row carries none — stated rather than stamped 0, which would read as 1970 and
   * turn "not recorded" into a duration measured in decades.
   */
  startedAt: number | null
  /** Epoch-ms this transition was observed. */
  occurredAt: number
  /**
   * The pull request the run opened, when it opened one. Null is a REAL answer on a terminal
   * event — a findings/spike pipeline opens nothing — and must not be read as "not known yet".
   */
  pullRequestUrl: string | null
  /** Present only on `run.failed`; null on the others. */
  failure: RunLifecycleFailure | null
  /**
   * Present only on `run.step_completed`; null on the run edges, which are about the run rather
   * than about any one step of it.
   */
  step: RunLifecycleStep | null
}

/**
 * Delivers run-lifecycle events outward. Best-effort BY CONTRACT: an implementation must never
 * propagate a receiver's outage into the engine, because the alternative is a broken endpoint
 * failing the runs it was registered to watch.
 */
export interface RunLifecycleSink {
  runTransitioned(workspaceId: string, event: RunLifecycleEvent): Promise<void>
}
