import { redactSecrets } from './redact.js'
import { log, type Logger } from './logger.js'

// The async job lifecycle for the deploy container. A render+apply+rollout can take
// minutes (image pulls, helm install, `kubectl rollout status`), so the backend does
// not hold a synchronous request open: it POSTs /jobs (which starts a background job and
// returns immediately) and polls GET /jobs/{id}. Two watchdogs bound every job so a
// container can never run forever — an inactivity timer and an overall max-duration cap.
// A slimmer sibling of the executor harness's runner (no Pi spans/progress/follow-ups —
// the deploy handler reports only its coarse phase).

/** Options threaded into the long-running CLI work so a watchdog can cancel it. */
export interface RunOptions {
  signal?: AbortSignal
  /** Reset the inactivity timer — called as the handler completes each CLI step. */
  onActivity?: () => void
  /** Mark the coarse lifecycle phase (`clone` / `render` / `apply` / `helm` / `rollout` / `url`). */
  onPhase?: (phase: string) => void
  /** A per-job child logger carrying the run's correlation fields. */
  log?: Logger
}

export type JobState = 'running' | 'done' | 'failed'

/** Structured failure cause carried on a failed view, so the backend classifies without regex. */
export type DeployFailureCause = 'inactivity-timeout' | 'max-duration' | 'deploy' | 'agent'

/**
 * The minimum a job result must expose: a structured `error` marks a job-level failure even
 * when the handler returned cleanly. Generic so {@link JobRegistry} reuses one watchdog.
 */
export interface JobResultBase {
  error?: string
  failureCause?: DeployFailureCause
}

/** The job view returned by GET /jobs/{id}. */
export interface JobView<TResult extends JobResultBase = JobResultBase> {
  id: string
  state: JobState
  startedAt: number
  heartbeatAt: number
  /** The coarse lifecycle phase the job is CURRENTLY in. Always present (seeded `starting`). */
  phase?: string
  /** Present when `state === 'done'`: the handler's structured result. */
  result?: TResult
  /** Present when `state === 'failed'`: the redacted one-line reason. */
  error?: string
  /** Present when `state === 'failed'`: the structured cause. */
  failureCause?: DeployFailureCause
}

interface JobEntry<TResult extends JobResultBase> extends JobView<TResult> {
  /** The in-flight work; retained so the entry isn't GC-surprising (not awaited externally). */
  promise: Promise<void>
  /** Abort the in-flight run (see {@link JobRegistry.abortAll}); set while running only. */
  abort?: (reason: string) => void
}

/** Watchdog windows that bound every job. Tunable via the container's env. */
export interface RunnerLimits {
  maxDurationMs: number
  inactivityMs: number
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function loadRunnerLimits(env: NodeJS.ProcessEnv = process.env): RunnerLimits {
  return {
    // 30 minutes: generous headroom for image pulls + helm installs + rollout waits
    // while still bounding a runaway container.
    maxDurationMs: intEnv(env.JOB_MAX_DURATION_MS, 30 * 60_000),
    // 10 minutes of no completed CLI step is treated as hung. A single `rollout status`
    // / `helm install` is far shorter; the per-command timeout (exec.ts) is the inner bound.
    inactivityMs: intEnv(env.JOB_INACTIVITY_MS, 10 * 60_000),
  }
}

function toView<TResult extends JobResultBase>(entry: JobEntry<TResult>): JobView<TResult> {
  const { promise: _promise, abort: _abort, ...view } = entry
  return { ...view }
}

/**
 * Tracks background jobs by id. Keyed by the backend-supplied job id so a re-dispatched
 * start re-attaches to the running job rather than starting a duplicate — which keeps the
 * durable driver's retries idempotent. Generic over the result shape so the same lifecycle
 * + watchdogs drive any kind.
 */
export class JobRegistry<
  TJob extends { jobId: string } = { jobId: string },
  TResult extends JobResultBase = JobResultBase,
> {
  private readonly jobs = new Map<string, JobEntry<TResult>>()

  constructor(
    private readonly limits: RunnerLimits,
    private readonly run: (job: TJob, opts: RunOptions) => Promise<TResult>,
    // Non-secret correlation fields to bind on the per-job logger (repo, namespace, …).
    private readonly describe: (job: TJob) => Record<string, unknown> = () => ({}),
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
      phase: 'starting',
      heartbeatAt: now,
      promise: Promise.resolve(),
    }
    this.jobs.set(id, entry)
    entry.promise = this.drive(entry, job)
    return toView(entry)
  }

  get(id: string): JobView<TResult> | undefined {
    const entry = this.jobs.get(id)
    return entry ? toView(entry) : undefined
  }

  /**
   * Abort every RUNNING job (fires each run's abort signal, which kills its kubectl/helm
   * children). The graceful-shutdown hook: a harness dying to SIGTERM must not orphan a
   * live CLI subprocess mid-apply. Returns the number of jobs aborted.
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
   * aborted jobs have actually settled instead of waiting out a fixed kill-grace window.
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

    let phase = 'starting'
    const markPhase = (next: string): void => {
      phase = next
      entry.phase = next
    }

    let inactivity: ReturnType<typeof setTimeout> | undefined
    const resetInactivity = (): void => {
      clearTimeout(inactivity)
      inactivity = setTimeout(() => {
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
    // Expose the abort for shutdown (see abortAll); cleared in `finally` once the job settles.
    entry.abort = (reason) => controller.abort(new Error(reason))

    jobLog.info('deploy job started', {})
    try {
      const result = await this.run(job, {
        signal: controller.signal,
        onActivity: heartbeat,
        onPhase: (next) => markPhase(next),
        log: jobLog,
      })
      markPhase('done')
      entry.state = 'done'
      entry.result = result
      if (result.error && result.failureCause) entry.failureCause = result.failureCause
      jobLog.info('deploy job finished', {
        durationMs: Date.now() - entry.startedAt,
        jobError: result.error ?? null,
      })
    } catch (error) {
      const failedInPhase = phase
      markPhase('failed')
      const { message, cause } = describeFailure(killReason, error, failedInPhase)
      entry.state = 'failed'
      entry.error = message
      entry.failureCause = cause
      jobLog.error('deploy job failed', {
        durationMs: Date.now() - entry.startedAt,
        reason: killReason ?? 'error',
        failureCause: cause,
        error: message,
      })
    } finally {
      clearTimeout(inactivity)
      clearTimeout(cap)
      entry.abort = undefined
      entry.heartbeatAt = Date.now()
    }
  }
}

/** Build the redacted one-line `error` + structured cause for a failed job. */
function describeFailure(
  killReason: 'inactivity' | 'max-duration' | undefined,
  error: unknown,
  phase: string,
): { message: string; cause: DeployFailureCause } {
  if (killReason === 'inactivity') {
    return {
      message: redactSecrets(
        `Deploy timed out: no progress for too long (hung in ${phase} phase).`,
      ),
      cause: 'inactivity-timeout',
    }
  }
  if (killReason === 'max-duration') {
    return {
      message: redactSecrets('Deploy exceeded its maximum duration and was stopped.'),
      cause: 'max-duration',
    }
  }
  const raw = error instanceof Error ? error.message : String(error)
  return { message: redactSecrets(raw), cause: 'deploy' }
}
