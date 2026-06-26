import { redactSecrets } from './redact.js'
import type { FollowUpLine } from './follow-ups.js'
import type { TodoProgress, ToolSpan } from './pi.js'
import { log } from './logger.js'

// The async job lifecycle for the container. A coding/explore run can take many
// minutes, so the backend does not hold a single synchronous request open: it POSTs
// /jobs (which starts a background job and returns immediately) and then polls
// GET /jobs/{id}. Two watchdogs bound every job so a container can never run forever —
// an inactivity timer (kills the agent when it stops producing output) and an overall
// max-duration cap. The work itself is the generic `agent` handler (see agent.ts); this
// file owns only the registry + watchdogs that drive any job to completion.

/** Options threaded into the long-running git/Pi work so a watchdog can cancel it. */
export interface RunOptions {
  signal?: AbortSignal
  onActivity?: () => void
  /** Receives the latest subtask counts as Pi updates its todo list. */
  onProgress?: (progress: TodoProgress) => void
  /** Receives one compact {@link ToolSpan} per completed tool call (observability). */
  onSpan?: (span: ToolSpan) => void
  /** Receives the forward-looking follow-up / question items the Coder streamed since the last poll. */
  onFollowUp?: (items: FollowUpLine[]) => void
}

export type JobState = 'running' | 'done' | 'failed'

/**
 * The minimum a job result must expose: a structured `error` marks a job-level
 * failure even when the HTTP run itself succeeded. Every agent result (explore /
 * coding / bootstrap / conflict) satisfies this, so {@link JobRegistry} is generic
 * over the result it tracks while reusing one watchdog/lifecycle.
 */
export interface JobResultBase {
  error?: string
}

/** The job view returned by GET /jobs/{id}, generic over the orchestration's result. */
export interface JobView<TResult extends JobResultBase = JobResultBase> {
  id: string
  state: JobState
  startedAt: number
  /** Epoch ms of the last sign of progress (job start, or Pi output). */
  heartbeatAt: number
  /**
   * Latest subtask progress from Pi's `todo` tool while the job runs — the
   * Worker poll surfaces it to the board (e.g. "3/8 done"). Absent until Pi
   * first touches its todo list (or if the model never uses it).
   */
  progress?: TodoProgress
  /** Present when `state === 'done'`: the orchestration's structured result. */
  result?: TResult
  /** Present when `state === 'failed'`: why the job faulted (or was killed). */
  error?: string
  /**
   * Tool spans accumulated SINCE THE LAST POLL (drain-on-read): the GET /jobs/{id}
   * handler returns the spans buffered since the previous poll and clears the buffer,
   * so the harness only ever holds one poll-interval's worth. Best-effort observability
   * — a dropped poll response loses at most one window. Absent until a tool runs.
   */
  spans?: ToolSpan[]
  /**
   * Forward-looking follow-up / question items the Coder streamed SINCE THE LAST POLL
   * (drain-on-read, exactly like {@link spans}): the GET /jobs/{id} handler returns the
   * items buffered since the previous poll and clears the buffer. The backend appends them
   * to the run's step so the Follow-up companion surfaces them live. Absent until the Coder
   * surfaces the first one (and only on a follow-ups-enabled coding run).
   */
  followUps?: FollowUpLine[]
}

interface JobEntry<TResult extends JobResultBase> extends JobView<TResult> {
  /** The in-flight work; retained so the entry isn't GC-surprising (not awaited externally). */
  promise: Promise<void>
  /** Spans buffered since the last drain (see {@link JobView.spans}). */
  spanBuffer: ToolSpan[]
  /** Follow-up items buffered since the last drain (see {@link JobView.followUps}). */
  followUpBuffer: FollowUpLine[]
}

/** Watchdog windows that bound every job. Tunable via the container's env. */
export interface RunnerLimits {
  /** Hard ceiling on total job wall-clock before it's force-failed. */
  maxDurationMs: number
  /** Force-fail the job if the agent produces no output for this long (hang guard). */
  inactivityMs: number
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function loadRunnerLimits(env: NodeJS.ProcessEnv = process.env): RunnerLimits {
  return {
    // 60 minutes: generous headroom for serious multi-file coding tasks while
    // still bounding a runaway container.
    maxDurationMs: intEnv(env.JOB_MAX_DURATION_MS, 60 * 60_000),
    // 10 minutes of zero output is treated as hung (a single long LLM/tool call
    // is far shorter; Pi streams events as it works). The per-git command ceiling
    // (`GIT_TIMEOUT_MS` in git.ts) is DERIVED from this value — a fixed margin below
    // it — so a slow clone/push (which emits no activity events) always times out
    // with git's own clear reason rather than this watchdog's "likely hung" message,
    // for any configured window. See the invariant note in git.ts.
    inactivityMs: intEnv(env.JOB_INACTIVITY_MS, 10 * 60_000),
  }
}

function toView<TResult extends JobResultBase>(entry: JobEntry<TResult>): JobView<TResult> {
  const {
    promise: _promise,
    spanBuffer: _spanBuffer,
    followUpBuffer: _followUpBuffer,
    ...view
  } = entry
  return { ...view }
}

/**
 * Tracks background jobs by id. Keyed by the backend-supplied job id (the per-step
 * job id) so a re-dispatched start re-attaches to the running job rather than starting
 * a duplicate — which keeps the durable driver's retries idempotent and avoids redoing
 * already-running work. Generic over the job/result shape so the same lifecycle +
 * inactivity/max-duration watchdogs drive every agent run.
 */
export class JobRegistry<TJob = unknown, TResult extends JobResultBase = JobResultBase> {
  private readonly jobs = new Map<string, JobEntry<TResult>>()

  constructor(
    private readonly limits: RunnerLimits,
    // The unit of work (the `agent` handler). Injectable so tests can drive the
    // registry's lifecycle/watchdog logic with a different runner.
    private readonly run: (job: TJob, opts: RunOptions) => Promise<TResult>,
  ) {}

  /** Start the job for `id`, or return the existing one (idempotent re-attach). */
  start(id: string, job: TJob): JobView<TResult> {
    const existing = this.jobs.get(id)
    if (existing) return toView(existing)

    const now = Date.now()
    const entry: JobEntry<TResult> = {
      id,
      state: 'running',
      startedAt: now,
      heartbeatAt: now,
      promise: Promise.resolve(),
      spanBuffer: [],
      followUpBuffer: [],
    }
    this.jobs.set(id, entry)
    entry.promise = this.drive(entry, job)
    return toView(entry)
  }

  /**
   * Poll the job — and DRAIN its tool-span buffer (drain-on-read). The GET /jobs/{id}
   * handler is the sole caller, so each poll returns the spans accumulated since the
   * previous poll and clears them, bounding the harness buffer to one poll interval.
   */
  get(id: string): JobView<TResult> | undefined {
    const entry = this.jobs.get(id)
    if (!entry) return undefined
    const view = toView(entry)
    if (entry.spanBuffer.length > 0) {
      view.spans = entry.spanBuffer
      entry.spanBuffer = []
    }
    if (entry.followUpBuffer.length > 0) {
      view.followUps = entry.followUpBuffer
      entry.followUpBuffer = []
    }
    return view
  }

  private async drive(entry: JobEntry<TResult>, job: TJob): Promise<void> {
    const controller = new AbortController()
    let killReason: 'inactivity' | 'max-duration' | undefined

    let inactivity: ReturnType<typeof setTimeout> | undefined
    const resetInactivity = (): void => {
      clearTimeout(inactivity)
      inactivity = setTimeout(() => {
        // First watchdog to fire wins the reason (a later timer firing in the
        // teardown window must not relabel why the job was killed).
        killReason ??= 'inactivity'
        controller.abort(new Error('inactivity timeout'))
      }, this.limits.inactivityMs)
    }
    const cap = setTimeout(() => {
      killReason ??= 'max-duration'
      controller.abort(new Error('max duration exceeded'))
    }, this.limits.maxDurationMs)
    const heartbeat = (): void => {
      entry.heartbeatAt = Date.now()
      resetInactivity()
    }
    resetInactivity()

    log.info('job started', { jobId: entry.id })
    try {
      const result = await this.run(job, {
        signal: controller.signal,
        onActivity: heartbeat,
        onProgress: (progress) => {
          entry.progress = progress
        },
        onSpan: (span) => {
          entry.spanBuffer.push(span)
        },
        onFollowUp: (items) => {
          entry.followUpBuffer.push(...items)
        },
      })
      entry.state = 'done'
      entry.result = result
      log.info('job finished', {
        jobId: entry.id,
        durationMs: Date.now() - entry.startedAt,
        jobError: result.error ?? null,
      })
    } catch (error) {
      // Defence-in-depth: scrub any credential that might have reached an error
      // message/stack before it is stored on the job view or written to logs.
      const message = redactSecrets(
        killReason === 'inactivity'
          ? `Aborted: no agent activity for ${Math.round(this.limits.inactivityMs / 1000)}s (likely hung)`
          : killReason === 'max-duration'
            ? `Aborted: exceeded max duration of ${Math.round(this.limits.maxDurationMs / 1000)}s`
            : error instanceof Error
              ? error.message
              : String(error),
      )
      entry.state = 'failed'
      entry.error = message
      log.error('job failed', {
        jobId: entry.id,
        durationMs: Date.now() - entry.startedAt,
        reason: killReason ?? 'error',
        error: message,
      })
    } finally {
      clearTimeout(inactivity)
      clearTimeout(cap)
      entry.heartbeatAt = Date.now()
    }
  }
}
