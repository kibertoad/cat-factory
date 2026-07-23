import { redactSecrets } from './redact.js'
import type { FollowUpLine } from './follow-ups.js'
import type { HarnessCallMetric, TodoProgress, ToolSpan } from './pi.js'
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
   * Receives each per-call telemetry row the moment the agent's CLI stream yields it, so a
   * run's model calls reach `llm_call_metrics` WHILE it runs rather than only in its terminal
   * result. The registry stamps the call's job-scoped {@link HarnessCallMetric.seq} and buffers
   * it for the next poll to drain.
   *
   * Call this for every metric you also put on the result — the SAME object, not a copy: the
   * stamped `seq` is what lets the backend recognise the terminal write of an already-recorded
   * call and skip it. A run that dies mid-flight (the container is evicted, the harness process
   * is OOM-killed) never produces a terminal result, so without this its entire token spend and
   * every prompt/response body are lost — exactly the run an operator most needs to inspect.
   */
  onCallMetric?: (call: HarnessCallMetric) => void
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
   * The coarse lifecycle phase the job is CURRENTLY in (`starting` → `clone` → `agent`
   * → `push` → `done`/`failed`), so the backend can surface WHAT the container is doing
   * rather than a blank "working" state — is it still cloning/preparing the checkout, or
   * has the agent begun making calls? The same per-phase marker that drives the stuck-run
   * breadcrumb on a failure, exposed live here while the job runs. Free-form; unknown
   * phases just show verbatim. Always present (seeded `starting` at job start).
   */
  phase?: string
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
  /**
   * Per-model-call telemetry the agent's CLI stream yielded SINCE THE LAST POLL
   * (drain-on-read, exactly like {@link spans}). The backend records these into
   * `llm_call_metrics` as they arrive, so a run's token spend and prompt/response bodies are
   * queryable while it is still running — and survive it dying before it can produce a
   * terminal result. Each carries a job-scoped `seq` so the terminal
   * {@link JobResultBase} list can re-offer the same calls without duplicating rows.
   * Absent until the agent's first model call (and on the proxy-metered Pi harness, whose
   * calls the LLM proxy meters directly).
   */
  callMetrics?: HarnessCallMetric[]
  /**
   * ADR 0026 D4: set when the cold-start watchdog fired — the job produced NO activity
   * within {@link RunnerLimits.coldStartMs} of starting, a likely onboarding/auth wedge.
   * This does NOT fail the job (the inactivity/max-duration watchdogs still own that).
   *
   * Legibility today is via the per-job container log line emitted the moment it fires
   * (the ~2-minute early signal the ADR wants); this field additionally carries the
   * structured record on the GET /jobs/{id} view so an operator hitting the endpoint — or a
   * future engine-side consumer — can read it without scraping logs. No engine code consumes
   * it yet, so surfacing it up through the runner-transport layer is deliberately deferred.
   * Absent on a job that produced output promptly (the overwhelming common case). Sticky once set.
   */
  coldStart?: { atMs: number; message: string }
}

interface JobEntry<TResult extends JobResultBase> extends JobView<TResult> {
  /** The in-flight work; retained so the entry isn't GC-surprising (not awaited externally). */
  promise: Promise<void>
  /** Spans buffered since the last drain (see {@link JobView.spans}). */
  spanBuffer: ToolSpan[]
  /** Follow-up items buffered since the last drain (see {@link JobView.followUps}). */
  followUpBuffer: FollowUpLine[]
  /** Call telemetry buffered since the last drain (see {@link JobView.callMetrics}). */
  callMetricBuffer: HarnessCallMetric[]
  /**
   * Next job-scoped {@link HarnessCallMetric.seq} to stamp. Monotonic for the life of the job
   * (never reset by a drain), so a call's row id stays unique across every poll window.
   */
  callMetricSeq: number
  /** Abort the in-flight run (see {@link JobRegistry.abortAll}); set while running only. */
  abort?: (reason: string) => void
}

/** Watchdog windows that bound every job. Tunable via the container's env. */
export interface RunnerLimits {
  /** Hard ceiling on total job wall-clock before it's force-failed. */
  maxDurationMs: number
  /** Force-fail the job if the agent produces no output for this long (hang guard). */
  inactivityMs: number
  /**
   * ADR 0026 D4: a short first-output window. If the job produces NO activity within this
   * long after start, emit a structured cold-start diagnostic (a likely onboarding/auth
   * wedge) — WITHOUT killing the run. Purely a legibility signal so a genuine cold-start
   * wedge surfaces in a couple of minutes instead of waiting out the full inactivity
   * window. Safely under the clone-inclusive phases (a large clone still streams git
   * progress, which counts as activity). Set to 0 to disable.
   */
  coldStartMs: number
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Like {@link intEnv} but allows an explicit 0 (used to DISABLE a window). */
function intEnvAllowZero(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
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
    // 2 minutes: comfortably longer than a warm agent's time-to-first-token yet far
    // under the 10-minute inactivity kill, so a truly output-less start is flagged early.
    coldStartMs: intEnvAllowZero(env.JOB_COLD_START_MS, 2 * 60_000),
  }
}

function toView<TResult extends JobResultBase>(entry: JobEntry<TResult>): JobView<TResult> {
  const {
    promise: _promise,
    spanBuffer: _spanBuffer,
    followUpBuffer: _followUpBuffer,
    callMetricBuffer: _callMetricBuffer,
    callMetricSeq: _callMetricSeq,
    abort: _abort,
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
      // Seed the live phase so a poll BEFORE the handler enters its first phase still
      // shows "starting" (the container is up; the agent hasn't begun cloning yet)
      // rather than an absent/blank phase.
      phase: 'starting',
      heartbeatAt: now,
      promise: Promise.resolve(),
      spanBuffer: [],
      followUpBuffer: [],
      callMetricBuffer: [],
      callMetricSeq: 0,
    }
    this.jobs.set(id, entry)
    entry.promise = this.drive(entry, job)
    return toView(entry)
  }

  /**
   * Poll the job — and DRAIN its observability buffers (drain-on-read). The GET /jobs/{id}
   * handler is the sole caller, so each poll returns the spans / follow-ups / call metrics
   * accumulated since the previous poll and clears them, bounding the harness buffers to one
   * poll interval.
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
    if (entry.callMetricBuffer.length > 0) {
      view.callMetrics = entry.callMetricBuffer
      entry.callMetricBuffer = []
    }
    return view
  }

  /**
   * Abort every RUNNING job (fires each run's abort signal, which SIGTERM→SIGKILLs its
   * CLI/git children via `killChildProcess`). The graceful-shutdown hook: a harness dying
   * to SIGTERM must not orphan a live agent subprocess — reparented, it would keep working
   * unsupervised (and, in native local mode, on the developer's own login). Returns the
   * number of jobs aborted.
   */
  abortAll(reason: string): number {
    let aborted = 0
    for (const entry of this.jobs.values()) {
      if (entry.state === 'running' && entry.abort) {
        entry.abort(reason)
        aborted += 1
      }
    }
    return aborted
  }

  /**
   * How many jobs are still RUNNING. Graceful shutdown polls this so it can exit the moment the
   * aborted jobs have actually settled (the common case: the CLI honours SIGTERM in ms) instead
   * of waiting out a fixed kill-grace window.
   */
  runningCount(): number {
    let running = 0
    for (const entry of this.jobs.values()) if (entry.state === 'running') running += 1
    return running
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
      // Surface the live phase on the view so a poll shows WHAT the container is doing
      // (cloning / running the agent / pushing) — the same marker drives the failure
      // breadcrumb. A terminal `done`/`failed` is set by the caller below.
      entry.phase = next
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

    // ADR 0026 D4: a one-shot cold-start watchdog. If the job produces no activity within
    // `coldStartMs`, record a structured diagnostic (a likely onboarding/auth wedge) so it
    // is legible early — it does NOT abort the run (the inactivity watchdog still owns
    // that). Cleared the moment the first activity arrives.
    let sawActivity = false
    let coldStart: ReturnType<typeof setTimeout> | undefined
    if (this.limits.coldStartMs > 0) {
      coldStart = setTimeout(() => {
        if (sawActivity) return
        const secs = Math.round(this.limits.coldStartMs / 1000)
        const message = `agent produced no output ${secs}s after start; possible onboarding/auth wedge (phase: ${phase})`
        entry.coldStart = { atMs: Date.now(), message }
        jobLog.warn('cold-start: no agent output', { afterMs: this.limits.coldStartMs, phase })
      }, this.limits.coldStartMs)
    }

    const heartbeat = (): void => {
      if (!sawActivity) {
        sawActivity = true
        clearTimeout(coldStart)
      }
      entry.heartbeatAt = Date.now()
      resetInactivity()
    }
    resetInactivity()
    // Expose the abort for shutdown (see abortAll); cleared in `finally` once the job settles.
    entry.abort = (reason) => controller.abort(new Error(reason))

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
        onCallMetric: (call) => {
          // Stamp the job-scoped sequence on the metric OBJECT: the handler keeps the same
          // instance for its terminal result, so both channels carry the same `seq` and the
          // backend mints one stable row id per call.
          call.seq = entry.callMetricSeq++
          entry.callMetricBuffer.push(call)
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
      clearTimeout(coldStart)
      entry.abort = undefined
      entry.heartbeatAt = Date.now()
    }
  }

  /**
   * Build the redacted one-line `error`, the structured {@link FailureCause}, and the extended
   * `detail` for a failed job. Watchdog kills set their structured cause (`inactivity-timeout` /
   * `max-duration`) — the backend classifies on that, so their message is a human-readable
   * breadcrumb of where they hung, no longer a regex-stable phrase; a thrown error keeps its own
   * message and its structured cause when tagged (a git op → `git`, an upstream API call → `api`),
   * else `agent`. All strings are credential-scrubbed.
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
