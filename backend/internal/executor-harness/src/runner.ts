import { redactSecrets } from './redact.js'
import type { FollowUpLine } from './follow-ups.js'
import type { ValidationReport } from './validation-checks.js'
import type { ReproductionReport } from './reproduction-proof.js'
import type { SliceReview } from './subagents.js'
import type { ObservedMcpServer } from './agent-capabilities.js'
import type { HarnessCallMetric, TodoProgress, ToolSpan } from './pi.js'
import { log, type Logger } from './logger.js'
import {
  type FailureCause,
  failureCauseOf,
  inactivityAbortMessage,
  maxDurationAbortMessage,
  toolSilenceAbortMessage,
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
   * Receives each completed PRE-PR VALIDATION attempt the moment the harness finishes running
   * the service's check commands, so the backend can surface the repair loop LIVE ("lint failed,
   * repairing — attempt 2 of 3") instead of only in the terminal result. Latest-wins (NOT a drain
   * buffer): a published attempt is final, and the loop republishes a whole new one per round.
   */
  onValidationReport?: (report: ValidationReport) => void
  /**
   * Receives each completed BUGFIX REPRODUCTION PROOF attempt the moment the harness finishes
   * running the declared check against both trees, so the backend can surface a failed
   * verification WHILE the repair loop still runs rather than only in the terminal result.
   * Latest-wins (NOT a drain buffer), exactly like {@link onValidationReport}: a published
   * attempt is final, and the loop republishes a whole new one — with a fresh `at` — per round.
   */
  onReproductionProof?: (report: ReproductionReport) => void
  /**
   * Receives the full set of per-slice reviews a parallel review has captured, republished each
   * time a slice's subagent returns. Latest-wins (NOT a drain buffer), for the same reason as
   * {@link onValidationReport} but with more at stake: these carry the slices' actual review work,
   * and a review whose aggregation never finishes is recoverable ONLY from what the backend
   * already persisted. Absent for a job that dispatched no subagents.
   */
  onSliceReviews?: (reviews: SliceReview[]) => void
  /**
   * Receives what the agent's CLI reported about the tool servers (MCP) it loaded, once it
   * announces its resolved session. Latest-wins (NOT a drain buffer) for the same reason as
   * {@link onValidationReport}, with an extra one of its own: the CLI announces the set ONCE,
   * near the start of the run, so a drain buffer would hand it to whichever poll happened to
   * land next and lose it entirely if that poll response were dropped — on the single fact this
   * whole channel exists to carry. Absent for a job that wired no tool servers.
   */
  onToolServers?: (observed: ObservedMcpServer[]) => void
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
  /**
   * The phase most recently marked via {@link onPhase} — the read side of the same marker, for
   * work that has to TELL the backend which phase it is in rather than merely record it. Today
   * that is the Pi path, whose calls are metered server-side by the LLM proxy: the harness tags
   * the proxy URL with this so a repair round's spend is attributable
   * (`docs/initiatives/token-burn-instrumentation.md`). Absent ⇒ no phase is carried and those
   * calls land in the backend's unattributed slice.
   */
  currentPhase?: () => string
  /** A per-job child logger carrying the run's correlation fields (jobId, repo, branch, …). */
  log?: Logger
  /**
   * Extra environment for the agent's child process, scoped to THIS job. The CLI is spawned with
   * `{...process.env, ...agentEnv}`, so these reach the agent and every shell tool it spawns.
   *
   * This is the seam for anything per-job that would otherwise be written to a process- or
   * HOME-global (the tester's secrets, a private-registry npmrc pointer). Those globals are only
   * per-job when the process is — true for a container, FALSE for the local native host-process
   * transport, which serves every concurrent ambient job from one process on the developer's own
   * HOME. Set it via `withAgentEnv`; never mutate `process.env` for a job.
   */
  agentEnv?: Record<string, string>
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
   * Legibility is via the per-job container log line emitted the moment it fires (the
   * ~2-minute early signal the ADR wants), this field on the GET /jobs/{id} view for an
   * operator hitting the endpoint, and — when the job goes on to fail — a sentence folded into
   * {@link detail}, which is the path that reaches the run without a new field on every
   * transport hop. Surfacing it on a still-RUNNING step (the early warning) remains deferred.
   * Absent on a job that produced output promptly (the overwhelming common case). Sticky once set.
   */
  coldStart?: { atMs: number; message: string }
  /**
   * The LATEST completed pre-PR validation attempt (see `docs/initiatives/pre-pr-validation.md`).
   * Unlike {@link spans}/{@link followUps} this is NOT drain-on-read: it is a whole-value latest
   * publish, so re-reading it on a later poll is harmless and a dropped poll loses nothing (the
   * next round republishes). Absent for a job whose service configured no checks.
   */
  validationReport?: ValidationReport
  /**
   * The LATEST completed bugfix reproduction-proof attempt (see
   * `docs/initiatives/bugfix-reproduction-proof.md`). Like {@link validationReport} — and unlike
   * {@link spans}/{@link followUps} — this is a whole-value latest publish, not drain-on-read, so
   * re-reading it on a later poll is harmless and a dropped poll loses nothing. Absent for a job
   * that carried no reproduction declaration.
   */
  reproductionReport?: ReproductionReport
  /**
   * The per-slice reviews captured so far on a parallel (subagent-fanned) review — each slice's
   * label, whether its subagent returned, and its verbatim report. A whole-value latest publish
   * like {@link validationReport}, not drain-on-read.
   *
   * This is the durable half of a PR review. The reviewer returns `slices`/`findings` only in its
   * TERMINAL structured output, so before this existed a review killed mid-run (or one whose
   * aggregation pass wedged) lost every finished slice and could only be re-run from zero. The
   * backend persists these onto the step as they arrive, which is what a manual resume re-aggregates
   * from. Absent for a job that dispatched no subagents.
   */
  sliceReviews?: SliceReview[]
  /**
   * What the agent's CLI reported about the tool servers (MCP) wired for this job when it started
   * up: per server, the status the CLI gave it and how many tools it contributed. A whole-value
   * latest publish like {@link validationReport}, not drain-on-read — the CLI announces this once
   * and every later poll re-reports the same set, so no poll can be the one that loses it.
   *
   * The complement of what the BACKEND recorded at dispatch, and the only source for the half it
   * cannot see: the dispatch record says why the platform withheld a tool, this says a wired
   * server failed to start anyway. Absent for a job that wired none, and for a harness whose CLI
   * reports nothing — which is why it is absent rather than empty (see `ObservedMcpServer`).
   */
  toolServers?: ObservedMcpServer[]
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

/**
 * The phase label every mode marks around its agent pass (`opts.onPhase('agent')`), and the only
 * one the tool-silence watchdog is armed for. Named rather than spelled at each site so the
 * watchdog's arming condition and the handlers' marking cannot drift apart silently.
 */
export const AGENT_PHASE = 'agent'

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
  /**
   * Stuck-run audit F13: force-fail the job if, while the AGENT phase is running, no tool call
   * completes for this long. The gap the other two watchdogs structurally cannot see — a model
   * that keeps talking (or thinking out loud) resets the inactivity timer on every chunk while
   * completing nothing, so the only remaining bound was the full wall-clock cap and the engine's
   * ~70-minute poll budget behind it.
   *
   * Armed ONLY during the agent phase, so the activity-silent phases (clone, dependency install,
   * push) are outside it by construction: those legitimately complete no tool calls, and they
   * are bounded by their own per-command timeouts. Set to 0 to disable.
   */
  toolSilenceMs: number
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
  const maxDurationMs = intEnv(env.JOB_MAX_DURATION_MS, 60 * 60_000)
  const inactivityMs = intEnv(env.JOB_INACTIVITY_MS, 10 * 60_000)
  return {
    // 60 minutes: generous headroom for serious multi-file coding tasks while
    // still bounding a runaway container.
    maxDurationMs,
    // 10 minutes of zero output is treated as hung (a single long LLM/tool call
    // is far shorter; Pi streams events as it works). The per-git command ceiling
    // (`GIT_TIMEOUT_MS` in git.ts) is DERIVED from this value — a fixed margin below
    // it — so a slow clone/push (which emits no activity events) always times out
    // with git's own clear reason rather than this watchdog's "likely hung" message,
    // for any configured window. See the invariant note in git.ts.
    inactivityMs,
    // 2 minutes: comfortably longer than a warm agent's time-to-first-token yet far
    // under the 10-minute inactivity kill, so a truly output-less start is flagged early.
    coldStartMs: intEnvAllowZero(env.JOB_COLD_START_MS, 2 * 60_000),
    toolSilenceMs: intEnvAllowZero(
      env.JOB_TOOL_SILENCE_MS,
      toolSilenceDefault(maxDurationMs, inactivityMs),
    ),
  }
}

/**
 * The tool-silence window when the operator has not set one: HALF the configured wall-clock cap,
 * DERIVED rather than a constant so lowering `JOB_MAX_DURATION_MS` tightens it too (a fixed
 * 30 minutes would sit past the whole budget of a deployment that runs 20-minute jobs, i.e. be
 * silently disabled).
 *
 * Clamped to at least the inactivity window because the two must not race: inactivity owns the
 * gone-quiet case and has the clearer diagnostic for it, so a tool-silence kill firing FIRST
 * would relabel an ordinary hang as a rabbit-hole. That ordering also means a genuinely silent
 * run always trips inactivity, which is why this watchdog needs no "but is it chatty?" test —
 * by the time it can fire, output has been arriving all along.
 */
function toolSilenceDefault(maxDurationMs: number, inactivityMs: number): number {
  return Math.max(Math.round(maxDurationMs / 2), inactivityMs)
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
 * How long {@link JobRegistry.abort} waits for an aborted job to actually settle before answering
 * with whatever state it is in. Sized like the graceful-shutdown window (and for the same reason):
 * the agent CLI normally honours SIGTERM in milliseconds, and this covers one that had to be
 * force-killed through the 5s SIGTERM→SIGKILL escalation, with a margin.
 */
const ABORT_SETTLE_MS = 6_000

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
   * Abort ONE job and answer with the state it actually reached.
   *
   * The caller is a backend that has decided this job must not run: it refused the dispatch as
   * blind, and the harness starts work on acceptance, so without this the agent runs to completion
   * and can push a branch and open a pull request for a step the engine already failed. Aborting
   * every job ({@link abortAll}) is not an option: a pooled container serves other runs.
   *
   * Waits for the job to SETTLE rather than returning the moment the signal is fired, because a
   * fired signal is not a stopped agent and the caller's whole problem is telling those apart: it
   * reports "stopped" to a human only on the strength of this answer. The window matches the
   * graceful-shutdown one for the same reason (the CLI usually honours SIGTERM in milliseconds; the
   * cap covers one that had to be force-killed through the 5s escalation in `killChildProcess`),
   * and a job still `running` when it expires is reported as such rather than assumed dead.
   *
   * Returns undefined when no job of that id exists here, which the caller must NOT read as a stop.
   */
  async abort(id: string, reason: string): Promise<JobState | undefined> {
    const entry = this.jobs.get(id)
    if (!entry) return undefined
    // Already terminal: nothing to stop, and re-firing a cleared abort would be a no-op anyway.
    // This is what makes the call idempotent for a caller that retries.
    if (entry.state !== 'running') return entry.state
    entry.abort?.(reason)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        entry.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ABORT_SETTLE_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    return entry.state
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
    let killReason: 'inactivity' | 'max-duration' | 'no-tool-progress' | undefined

    const jobLog = log.child({ jobId: entry.id, ...this.describe(job) })

    // Stuck-run audit F13: the third watchdog, and the only one that can see a model which
    // keeps TALKING while completing nothing — its output resets the inactivity timer on every
    // chunk, and it is nowhere near the wall-clock cap. Armed only while the agent phase runs,
    // and reset by every completed tool call.
    let toolSilence: ReturnType<typeof setTimeout> | undefined
    const clearToolSilence = (): void => {
      clearTimeout(toolSilence)
      toolSilence = undefined
    }
    const armToolSilence = (): void => {
      clearToolSilence()
      if (this.limits.toolSilenceMs <= 0) return
      toolSilence = setTimeout(() => {
        // First watchdog to fire wins the reason (see `resetInactivity` below).
        killReason ??= 'no-tool-progress'
        controller.abort(new Error('no tool progress'))
      }, this.limits.toolSilenceMs)
    }

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
      // The tool-silence window belongs to the AGENT: clone, dependency install and push
      // legitimately complete no tool calls and carry their own per-command timeouts. Each
      // re-entry (a validation- or reproduction-repair loop returns here) starts a fresh window.
      if (next === AGENT_PHASE) armToolSilence()
      else clearToolSilence()
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

    // When the run was last heard from — the agent's own output, or a synthetic keep-alive beat
    // from an activity-silent phase (see `silenceClause`, which is careful not to claim more than
    // that). Unset until the first of either, which is both the cold-start watchdog's "has it
    // spoken yet" test and, on a failure, the difference between a run that died mid-work and one
    // that never got going at all.
    let lastActivityAt: number | undefined

    // ADR 0026 D4: a one-shot cold-start watchdog. If the job produces no activity within
    // `coldStartMs`, record a structured diagnostic (a likely onboarding/auth wedge) so it
    // is legible early — it does NOT abort the run (the inactivity watchdog still owns
    // that). Cleared the moment the first activity arrives.
    let coldStart: ReturnType<typeof setTimeout> | undefined
    if (this.limits.coldStartMs > 0) {
      coldStart = setTimeout(() => {
        if (lastActivityAt !== undefined) return
        const secs = Math.round(this.limits.coldStartMs / 1000)
        const message = `agent produced no output ${secs}s after start; possible onboarding/auth wedge (phase: ${phase})`
        entry.coldStart = { atMs: Date.now(), message }
        jobLog.warn('cold-start: no agent output', { afterMs: this.limits.coldStartMs, phase })
      }, this.limits.coldStartMs)
    }

    const heartbeat = (): void => {
      if (lastActivityAt === undefined) clearTimeout(coldStart)
      lastActivityAt = Date.now()
      entry.heartbeatAt = lastActivityAt
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
          // A completed tool call IS the progress this watchdog measures.
          if (phase === AGENT_PHASE) armToolSilence()
        },
        onFollowUp: (items) => {
          entry.followUpBuffer.push(...items)
        },
        onValidationReport: (report) => {
          entry.validationReport = report
        },
        onSliceReviews: (reviews) => {
          entry.sliceReviews = reviews
        },
        onToolServers: (observed) => {
          entry.toolServers = observed
        },
        onReproductionProof: (report) => {
          entry.reproductionReport = report
        },
        onCallMetric: (call) => {
          // Stamp the job-scoped sequence on the metric OBJECT: the handler keeps the same
          // instance for its terminal result, so both channels carry the same `seq` and the
          // backend mints one stable row id per call.
          call.seq = entry.callMetricSeq++
          // …and the phase the job is in RIGHT NOW, which is what spent the call: the handlers
          // mark `validation-repair` / `reproduction-repair` around each repair pass, so a
          // looped run's telemetry says which loop the tokens went to instead of filing every
          // turn under one undifferentiated "agent"
          // (`docs/initiatives/token-burn-instrumentation.md`). Stamped at EMIT time, not at
          // drain time: a poll can land long after the phase moved on.
          call.phase = phase
          entry.callMetricBuffer.push(call)
        },
        onPhase: (next) => markPhase(next),
        currentPhase: () => phase,
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
      const { message, cause, detail } = this.describeFailure({
        killReason,
        error,
        phase: failedInPhase,
        lastTool,
        phaseTimingsMs,
        lastActivityAt,
        startedAt: entry.startedAt,
        coldStart: entry.coldStart,
      })
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
      clearToolSilence()
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
   *
   * `detail` is where the evidence the harness already holds but the one-line `error` has no room
   * for lands: the phase breakdown, the {@link failureBreadcrumb} (last completed tool + how long
   * the run had been silent), and the cold-start diagnostic when that watchdog recorded one. It is
   * the only one of the three that reaches the run's failure record, so a diagnostic that isn't
   * folded in here is effectively invisible outside the container log.
   */
  private describeFailure(ctx: FailureContext): {
    message: string
    cause: FailureCause
    detail: string
  } {
    const breadcrumb = failureBreadcrumb(ctx)
    const phaseBreakdown = Object.entries(ctx.phaseTimingsMs)
      .map(([p, ms]) => `${p}=${Math.round(ms / 1000)}s`)
      .join(', ')
    const cold = ctx.coldStart ? ` Cold start: ${ctx.coldStart.message}.` : ''
    if (ctx.killReason === 'inactivity') {
      return {
        message: redactSecrets(
          `${inactivityAbortMessage(this.limits.inactivityMs)} (likely hung in ${ctx.phase} phase; ${breadcrumb})`,
        ),
        cause: 'inactivity-timeout',
        detail: redactSecrets(
          `Phase timings: ${phaseBreakdown || '(none)'}. ${breadcrumb}.${cold}`,
        ),
      }
    }
    if (ctx.killReason === 'max-duration') {
      return {
        message: redactSecrets(maxDurationAbortMessage(this.limits.maxDurationMs)),
        cause: 'max-duration',
        detail: redactSecrets(
          `Phase timings: ${phaseBreakdown || '(none)'}. ${breadcrumb}.${cold}`,
        ),
      }
    }
    if (ctx.killReason === 'no-tool-progress') {
      return {
        // The breadcrumb carries the last completed tool, which is the whole diagnostic here:
        // it names what the agent was doing when it stopped doing anything.
        message: redactSecrets(
          `${toolSilenceAbortMessage(this.limits.toolSilenceMs)} (${breadcrumb})`,
        ),
        cause: 'no-tool-progress',
        detail: redactSecrets(
          `Phase timings: ${phaseBreakdown || '(none)'}. ${breadcrumb}.${cold}`,
        ),
      }
    }
    const raw = ctx.error instanceof Error ? ctx.error.message : String(ctx.error)
    // A thrown error tagged with a structured cause (a git op / an upstream API call) keeps
    // it; an untagged throw is a generic agent failure.
    return {
      message: redactSecrets(raw),
      cause: failureCauseOf(ctx.error) ?? 'agent',
      detail: redactSecrets(
        `${phaseBreakdown ? `Phase timings: ${phaseBreakdown}. ` : ''}Failed in ${ctx.phase} phase; ${breadcrumb}.${cold}`,
      ),
    }
  }
}

/**
 * Everything known about a job the moment it failed. One value rather than a growing positional
 * list, and every field REQUIRED (explicitly `undefined` where absent) so a new failure dimension
 * has to be threaded at the call site instead of silently defaulting away.
 */
interface FailureContext {
  /** Which watchdog killed it; unset when the run threw on its own. */
  killReason: 'inactivity' | 'max-duration' | 'no-tool-progress' | undefined
  error: unknown
  /** The phase the job was IN when it failed (captured before the `failed` transition). */
  phase: string
  /** The last tool that COMPLETED, when any had. */
  lastTool: { name: string; at: number } | undefined
  phaseTimingsMs: Record<string, number>
  /** When the run last produced any output; `undefined` ⇒ it never produced a single byte. */
  lastActivityAt: number | undefined
  /** Job start — the silence window's origin when there was never any output. */
  startedAt: number
  /** The cold-start diagnostic, when that watchdog recorded one (see {@link JobView.coldStart}). */
  coldStart: { atMs: number; message: string } | undefined
}

/**
 * How long a run must have been quiet before the breadcrumb calls it out. Well above a slow
 * model turn or a long tool call, so this fires on a genuine stall rather than on normal
 * think time.
 */
const SILENCE_BREADCRUMB_MS = 30_000

/**
 * Where the job was, and how quiet it had gone, when it failed.
 *
 * The silence half matters because the exit status alone cannot distinguish a crash from a
 * stall: an agent CLI that gives up on a failing upstream request exits NON-ZERO with nothing
 * on stderr, which reads exactly like a crash — while its phase timing (minutes) and its
 * silence (all of them) say "it never got an answer". Omitted when the run was producing
 * output right up to the failure (the common case, where it is noise), and for an inactivity
 * kill, whose own message already states the window it waited out.
 */
function failureBreadcrumb(ctx: FailureContext): string {
  const now = Date.now()
  // `lastTool` is the last tool that COMPLETED (a span is emitted on tool end), so when the
  // hang is inside a still-running tool the breadcrumb points at the prior one — worded
  // "last completed tool" so the reader knows the stuck call may be the next, unfinished one.
  const tool = ctx.lastTool
    ? `last completed tool ${ctx.lastTool.name} ${Math.round((now - ctx.lastTool.at) / 1000)}s ago`
    : 'no tool had completed yet'
  return [tool, silenceClause(ctx, now)].filter(Boolean).join(', ')
}

/**
 * The silence half of {@link failureBreadcrumb}; empty when silence isn't part of the story —
 * which includes the fast failures (a missing env var, a git auth rejection) where the run was
 * never going to have spoken yet and saying so would be pure noise.
 *
 * What it measures is the ACTIVITY channel, which carries the agent's own output plus the
 * synthetic keep-alive beats the activity-silent phases feed the inactivity watchdog (dependency
 * install, pre-PR validation, the reproduction proof, the frontend stand-up). So the wording
 * claims no more than the channel supports — "no activity", not "no agent output": a run whose
 * install phase beat every 30s and then died has been heard from, even though the agent itself
 * never spoke. The window's origin is the job start, so it spans the `starting`/`clone` phases
 * too; the phase breakdown sits beside it in the same `detail` for the reader who needs the
 * split.
 *
 * Making this say "the AGENT last spoke" specifically would mean separating real output from
 * liveness beats at the {@link RunOptions} seam, which is a change to what the cold-start and
 * inactivity watchdogs fire on — deliberately not folded into this diagnostic-only fix.
 */
function silenceClause(ctx: FailureContext, now: number): string {
  if (ctx.killReason === 'inactivity') return ''
  const silentMs = now - (ctx.lastActivityAt ?? ctx.startedAt)
  if (silentMs < SILENCE_BREADCRUMB_MS) return ''
  const secs = Math.round(silentMs / 1000)
  return ctx.lastActivityAt === undefined ? `no activity at all in ${secs}s` : `silent for ${secs}s`
}
