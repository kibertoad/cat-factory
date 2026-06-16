import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Job, RunResult } from './job.js'
import {
  cloneRepo,
  commitAll,
  createBranch,
  openPullRequest,
  pushBranch,
  redactSecrets,
} from './git.js'
import { runPi, type TodoProgress, writeAgentsContext, writePiModelsConfig } from './pi.js'
import { log } from './logger.js'

// Async job execution for the implementation container. A coding run can take
// many minutes, so the Worker no longer holds a single synchronous request open:
// it POSTs /run (which starts a background job and returns immediately) and then
// polls GET /jobs/{id}. Two watchdogs bound every job so a container can never
// run forever — an inactivity timer (kills Pi when it stops producing output)
// and an overall max-duration cap.

/** Options threaded into the long-running git/Pi work so a watchdog can cancel it. */
export interface RunOptions {
  signal?: AbortSignal
  onActivity?: () => void
  /** Receives the latest subtask counts as Pi updates its todo list. */
  onProgress?: (progress: TodoProgress) => void
}

/** Run one implementation job end to end: clone → Pi implements → commit → push → PR. */
export async function handleRun(job: Job, opts: RunOptions = {}): Promise<RunResult> {
  const { signal, onActivity, onProgress } = opts
  const dir = await mkdtemp(join(tmpdir(), 'impl-'))
  try {
    await cloneRepo({ repo: job.repo, ghToken: job.ghToken, dir, signal })
    await createBranch(dir, job.headBranch, signal)
    await writeAgentsContext(dir, job.systemPrompt)
    await writePiModelsConfig({ model: job.model, proxyBaseUrl: job.proxyBaseUrl })

    const summary = await runPi({
      cwd: dir,
      model: job.model,
      userPrompt: job.userPrompt,
      sessionToken: job.sessionToken,
      signal,
      onActivity,
      onProgress,
    })

    const committed = await commitAll(dir, job.pr.title, signal)
    if (!committed) {
      return { summary, branch: job.headBranch, error: 'Pi produced no file changes' }
    }
    await pushBranch(dir, job.headBranch, job.ghToken, signal)
    const prUrl = await openPullRequest({
      owner: job.repo.owner,
      name: job.repo.name,
      ghToken: job.ghToken,
      head: job.headBranch,
      base: job.repo.baseBranch,
      pr: job.pr,
      apiBase: job.githubApiBase,
      signal,
    })
    return { prUrl, branch: job.headBranch, summary }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export type JobState = 'running' | 'done' | 'failed'

/** The job view returned by GET /jobs/{id}. */
export interface JobView {
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
  result?: RunResult
  /** Present when `state === 'failed'`: why the job faulted (or was killed). */
  error?: string
}

interface JobEntry extends JobView {
  /** The in-flight work; retained so the entry isn't GC-surprising (not awaited externally). */
  promise: Promise<void>
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
    // is far shorter; Pi streams events as it works).
    inactivityMs: intEnv(env.JOB_INACTIVITY_MS, 10 * 60_000),
  }
}

function toView(entry: JobEntry): JobView {
  const { promise: _promise, ...view } = entry
  return { ...view }
}

/**
 * Tracks background implementation jobs by id. Keyed by the Worker-supplied job
 * id (the execution id) so a re-dispatched /run re-attaches to the running job
 * rather than starting a duplicate — which keeps the durable driver's retries
 * idempotent and avoids redoing already-running work.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobEntry>()

  constructor(
    private readonly limits: RunnerLimits,
    // The unit of work; defaults to the real orchestration. Injectable so tests
    // can drive the registry's lifecycle/watchdog logic without git or Pi.
    private readonly run: (job: Job, opts: RunOptions) => Promise<RunResult> = handleRun,
  ) {}

  /** Start the job for `id`, or return the existing one (idempotent re-attach). */
  start(id: string, job: Job): JobView {
    const existing = this.jobs.get(id)
    if (existing) return toView(existing)

    const now = Date.now()
    const entry: JobEntry = {
      id,
      state: 'running',
      startedAt: now,
      heartbeatAt: now,
      promise: Promise.resolve(),
    }
    this.jobs.set(id, entry)
    entry.promise = this.drive(entry, job)
    return toView(entry)
  }

  get(id: string): JobView | undefined {
    const entry = this.jobs.get(id)
    return entry ? toView(entry) : undefined
  }

  private async drive(entry: JobEntry, job: Job): Promise<void> {
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

    log.info('job started', { jobId: entry.id, headBranch: job.headBranch })
    try {
      const result = await this.run(job, {
        signal: controller.signal,
        onActivity: heartbeat,
        onProgress: (progress) => {
          entry.progress = progress
        },
      })
      entry.state = 'done'
      entry.result = result
      log.info('job finished', {
        jobId: entry.id,
        durationMs: Date.now() - entry.startedAt,
        opened: Boolean(result.prUrl),
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
