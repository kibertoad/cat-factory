import { redactSecrets } from './redact.js'
import type { FollowUpLine } from './follow-ups.js'
import type { TodoProgress, ToolSpan } from './pi.js'
import { log, type Logger } from './logger.js'
import {
  type FailureCause,
  failureCauseOf,
  inactivityAbortMessage,
  maxDurationAbortMessage,
} from './failure.js'

/** Non-secret correlation fields a job carries on every log line (jobId, repo, branch, …). */
type LogFields = Record<string, unknown>

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
  /**
   * Mark the coarse lifecycle phase the handler has entered (`clone` / `agent` / `push` / …).
   * Drives the stuck-run breadcrumb: an inactivity kill reports WHICH phase was hung, and the
   * per-phase wall-clock is logged on completion. Free-form; unknown phases just show verbatim.
   */
  onPhase?: (phase: string) => void
  /** A per-job child logger carrying the run's correlation fields (jobId, repo, branch, …). */
  log?: Logger
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
  /**
   * The structured reason a clean-exit result failed (set alongside `error` by a handler that
   * finished but produced an unusable/failed result — no-usable-output, no-changes, …). The
   * registry copies it onto the job view's `failureCause`. Absent on a watchdog/throw failure
   * (the registry sets that cause itself). See {@link FailureCause}.
   */
  failureCause?: FailureCause
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
   * Present when `state === 'failed'`: the STRUCTURED failure cause, so the backend can
   * classify the failure without regex-matching {@link error}. Backward compatible — the
   * backend prefers this and falls back to the (still-stable) `error` regex when absent.
   * Container eviction is NOT represented here (the runtime facade detects that from a
   * vanished container); see {@link FailureCause}.
   */
  failureCause?: FailureCause
  /**
   * Present when `state === 'failed'`: an extended, redacted diagnostic (phase-timing
   * breakdown, last-tool breadcrumb, …) distinct from the one-line {@link error}. The
   * backend surfaces it as the failure `detail` on the board card. Best-effort.
   */
  detail?: string
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
    // Non-secret correlation fields to bind on the per-job logger (repo, branch, agentKind).
    // The registry is generic over the job shape, so the kind supplies this extractor; the
    // job id is always bound. Defaults to no extra fields.
    private readonly describe: (job: TJob) => LogFields = () => ({}),
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

    const jobLog = log.child({ jobId: entry.id, ...this.describe(job) })

    // Stuck-run breadcrumb: the coarse phase the handler is in, per-phase wall-clock, and
    // the last completed tool — so an inactivity kill can say WHERE it hung instead of a
    // bare "likely hung", and the finish/fail log carries the phase-timing breakdown.
    let phase = 'starting'
    let phaseEnteredAt = Date.now()
    const phaseTimingsMs: Record<string, number> = {}
    const markPhase = (next: string): void => {
      const now = Date.now()
      phaseTimingsMs[phase] = (phaseTimingsMs[phase] ?? 0) + (now - phaseEnteredAt)
      phase = next
      phaseEnteredAt = now
    }
    let lastTool: { name: string; at: number } | undefined

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

    jobLog.info('job started', {})
    try {
      const result = await this.run(job, {
        signal: controller.signal,
        onActivity: heartbeat,
        onProgress: (progress) => {
          entry.progress = progress
        },
        onSpan: (span) => {
          entry.spanBuffer.push(span)
          lastTool = { name: span.tool, at: span.endedAt }
        },
        onFollowUp: (items) => {
          entry.followUpBuffer.push(...items)
        },
        onPhase: (next) => markPhase(next),
        log: jobLog,
      })
      markPhase('done')
      entry.state = 'done'
      entry.result = result
      // A clean-exit result can still be a failure (e.g. no usable output): carry its
      // structured cause onto the view so the backend classifies it without regex.
      if (result.error && result.failureCause) entry.failureCause = result.failureCause
      jobLog.info('job finished', {
        durationMs: Date.now() - entry.startedAt,
        jobError: result.error ?? null,
        phaseTimingsMs,
      })
    } catch (error) {
      // Capture the phase the job was IN before recording the 'failed' transition, so the
      // breadcrumb names where it hung (markPhase below would otherwise overwrite it).
      const failedInPhase = phase
      markPhase('failed')
      const { message, cause, detail } = this.describeFailure(
        killReason,
        error,
        failedInPhase,
        lastTool,
        phaseTimingsMs,
      )
      entry.state = 'failed'
      entry.error = message
      entry.failureCause = cause
      entry.detail = detail
      jobLog.error('job failed', {
        durationMs: Date.now() - entry.startedAt,
        reason: killReason ?? 'error',
        failureCause: cause,
        error: message,
        phaseTimingsMs,
      })
    } finally {
      clearTimeout(inactivity)
      clearTimeout(cap)
      entry.heartbeatAt = Date.now()
    }
  }

  /**
   * Build the redacted one-line `error`, the structured {@link FailureCause}, and the extended
   * `detail` for a failed job. Watchdog kills keep their regex-stable phrase (so the backend's
   * `classifyBootstrapFailure` fallback still works) and gain a breadcrumb of where they hung;
   * a thrown error keeps its own message and its structured cause when tagged (a git op → `git`,
   * an upstream API call → `api`), else `agent`. All strings are credential-scrubbed.
   */
  private describeFailure(
    killReason: 'inactivity' | 'max-duration' | undefined,
    error: unknown,
    phase: string,
    lastTool: { name: string; at: number } | undefined,
    phaseTimingsMs: Record<string, number>,
  ): { message: string; cause: FailureCause; detail: string } {
    // `lastTool` is the last tool that COMPLETED (a span is emitted on tool end), so when the
    // hang is inside a still-running tool the breadcrumb points at the prior one — worded
    // "last completed tool" so the reader knows the stuck call may be the next, unfinished one.
    const breadcrumb = lastTool
      ? `last completed tool ${lastTool.name} ${Math.round((Date.now() - lastTool.at) / 1000)}s ago`
      : 'no tool had completed yet'
    const phaseBreakdown = Object.entries(phaseTimingsMs)
      .map(([p, ms]) => `${p}=${Math.round(ms / 1000)}s`)
      .join(', ')
    if (killReason === 'inactivity') {
      return {
        message: redactSecrets(
          `${inactivityAbortMessage(this.limits.inactivityMs)} (likely hung in ${phase} phase; ${breadcrumb})`,
        ),
        cause: 'inactivity-timeout',
        detail: redactSecrets(`Phase timings: ${phaseBreakdown || '(none)'}. ${breadcrumb}.`),
      }
    }
    if (killReason === 'max-duration') {
      return {
        message: redactSecrets(maxDurationAbortMessage(this.limits.maxDurationMs)),
        cause: 'max-duration',
        detail: redactSecrets(`Phase timings: ${phaseBreakdown || '(none)'}. ${breadcrumb}.`),
      }
    }
    const raw = error instanceof Error ? error.message : String(error)
    // A thrown error tagged with a structured cause (a git op / an upstream API call) keeps
    // it; an untagged throw is a generic agent failure.
    return {
      message: redactSecrets(raw),
      cause: failureCauseOf(error) ?? 'agent',
      detail: redactSecrets(
        `${phaseBreakdown ? `Phase timings: ${phaseBreakdown}. ` : ''}Failed in ${phase} phase; ${breadcrumb}.`,
      ),
    }
  }
}
