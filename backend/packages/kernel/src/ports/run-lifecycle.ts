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
 * The lifecycle transitions an external receiver can subscribe to. Deliberately only the
 * EDGES a caller cannot already infer cheaply — a per-step feed would be a firehose (the engine
 * emits on every container poll) and is what the SSE endpoints are for.
 */
export const RUN_LIFECYCLE_EVENTS = ['run.started', 'run.completed', 'run.failed'] as const
export type RunLifecycleEventKind = (typeof RUN_LIFECYCLE_EVENTS)[number]

/** Whether `value` is one of the known lifecycle events (a lenient decode for a stored filter). */
export function isRunLifecycleEventKind(value: unknown): value is RunLifecycleEventKind {
  return typeof value === 'string' && (RUN_LIFECYCLE_EVENTS as readonly string[]).includes(value)
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
}

/**
 * Delivers run-lifecycle events outward. Best-effort BY CONTRACT: an implementation must never
 * propagate a receiver's outage into the engine, because the alternative is a broken endpoint
 * failing the runs it was registered to watch.
 */
export interface RunLifecycleSink {
  runTransitioned(workspaceId: string, event: RunLifecycleEvent): Promise<void>
}
