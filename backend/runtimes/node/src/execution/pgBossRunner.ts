import type { OperationalMetrics, StaleAgentRun, WorkRunner } from '@cat-factory/kernel'
import { createQueueWithDeadLetter } from './deadLetter.js'
import { describeError, getErrorMessage, runBestEffort } from '@cat-factory/kernel'
import {
  type Logger,
  type ServerContainer,
  type SweepHealthTracker,
  sweepPassRecoveredNothing,
} from '@cat-factory/server'
import type { Job, JobInsert, PgBoss, SendOptions } from 'pg-boss'
import { BOOTSTRAP_QUEUE, reenqueueStaleBootstrap } from './bootstrapRunner.js'
import { ENV_CONFIG_REPAIR_QUEUE, reenqueueStaleEnvConfigRepair } from './envConfigRepairRunner.js'
import { type DriveConfig, driveExecution } from './drive.js'
import { type JobStore, classifyAdvanceJob, reclaimAdvanceJob } from './reclaim.js'

// Durable execution on pg-boss: the analogue of the Worker's Cloudflare Workflows
// driver. `startRun` enqueues an advance job (deduped per run via singletonKey); a
// registered worker drives the run to a standstill via `driveExecution`. A resolved
// decision re-enqueues an advance to resume a parked run. State lives in Postgres,
// so a crash mid-run is recovered two ways: pg-boss retries an expired/failed advance
// job, and the stale-run sweeper re-enqueues runs still `running` in storage.

const QUEUE = 'execution.advance'

// The queue MUST be created with the `exclusive` policy for the dedup below to hold.
// Under pg-boss's default `standard` policy, `singletonKey` alone enforces NO uniqueness
// (the singleton unique indexes are policy-gated, and the policy-independent one requires
// `singletonSeconds`, which we don't set). `exclusive` makes (name, singletonKey) unique
// across the `created`/`retry`/`active` states, so at most one advance job per run is
// alive at a time and a duplicate `send` is an `ON CONFLICT DO NOTHING` no-op.
const QUEUE_POLICY = 'exclusive' as const

interface AdvanceJob {
  workspaceId: string
  executionId: string
}

/**
 * Send options for an advance job. `singletonKey` (the run id) is the linchpin — but only
 * because the queue is created `exclusive` (see {@link QUEUE_POLICY}): while an advance job
 * for a run is active/queued/retrying, pg-boss suppresses any duplicate send — so re-enqueues
 * from `signalDecision` and the stale-run sweeper are safe no-ops for a run that is still being
 * driven, and only take effect once the prior job is gone. That lets the sweeper use a short
 * lease without ever double-driving a healthy run.
 *
 * `expireInSeconds` MUST exceed the longest a single advance can run (a drive can poll
 * a container job for `jobMaxPolls * jobPollInterval`, well past pg-boss's 15s default);
 * otherwise pg-boss would expire a healthy long-running drive, free its singletonKey,
 * and let a second driver start. `heartbeatSeconds` is the separate, fast crash-recovery
 * lever: a live worker auto-heartbeats its active job, so a crashed worker is detected
 * (and its job retried) within `heartbeatSeconds` rather than waiting out the large
 * `expireInSeconds` cap. `retryLimit` makes pg-boss itself re-drive a job that throws, expires, or
 * misses its heartbeat (a crashed worker), the durable backstop. See `executionRuntime` for how
 * both are sized, and {@link driveJobOptions} for why the retry delay is FLAT.
 */
export interface AdvanceQueueOptions {
  expireInSeconds: number
  heartbeatSeconds: number
  retryLimit: number
  retryDelaySeconds: number
}

/**
 * The single source of truth for a DRIVE job's options, across all four drive queues (execution,
 * bootstrap, env-test, env-config-repair) and across both enqueue paths, `send` (one job) and
 * `insert` (a batch), so a batched re-drive carries EXACTLY the same singletonKey/retry/expiry/
 * heartbeat semantics as an individual `send`. The dedup linchpin cannot drift between the two
 * enqueue paths, and the retry policy below cannot drift between the four queues, which is what it
 * did as four identical literals.
 *
 * `retryBackoff` is OFF, and that is a claim about what these jobs actually fail from. Exponential
 * backoff is sized for a job whose INPUT is bad, where retrying sooner only fails sooner. A drive
 * job's dominant failure is neither: the worker holding it went away (a deploy, a crash, a rebuild
 * under `node --watch` on a developer's laptop), pg-boss reports that as `job heartbeat timeout`,
 * and the very next attempt would have succeeded. Backing off there turns a five-second process
 * restart into minutes of a run sitting still, growing with every restart, and NOTHING else can
 * shorten it: the stale-run sweeper classifies a `retry`-state job as `live` (`classifyAdvanceJob`,
 * correctly, since it is queued and will be picked up) and the `exclusive` policy makes a fresh `send` a
 * no-op while it exists, so this delay alone decides when the run moves again.
 *
 * A flat delay holds the worst case at roughly `heartbeatSeconds` plus `retryDelaySeconds`. The two
 * mechanisms that genuinely do want patience are untouched: `retryLimit` still bounds a job that
 * keeps throwing, and once it is spent the job leaves the created/active/retry set, which is
 * exactly when `classifyAdvanceJob` starts answering `missing` and the stale-run sweeper takes over
 * on its own interval with the hard-stall backstop behind it. The one queue deliberately left on
 * backoff is `githubSyncRunner`: it fails from a rate-limited vendor, which is the case backoff is
 * for.
 */
export function driveJobOptions(singletonKey: string, opts: AdvanceQueueOptions) {
  return {
    singletonKey,
    expireInSeconds: opts.expireInSeconds,
    heartbeatSeconds: opts.heartbeatSeconds,
    retryLimit: opts.retryLimit,
    retryDelay: opts.retryDelaySeconds,
    retryBackoff: false,
  }
}

function sendOptions(executionId: string, opts: AdvanceQueueOptions): SendOptions {
  return driveJobOptions(executionId, opts)
}

/**
 * A batch-insert row for one advance job — the `boss.insert([...])` analogue of
 * {@link sendOptions}. `insert` compiles to a single
 * `INSERT … SELECT FROM json_to_recordset(…) ON CONFLICT DO NOTHING`, and the `exclusive`
 * queue's `(name, singleton_key)` unique index gates that conflict PER ROW — so a batched
 * re-drive dedupes exactly like N individual `send`s (a row whose run already has a live
 * advance job is a per-row no-op; the rest insert), preserving the sweeper's
 * no-double-drive guarantee while collapsing N round-trips into one.
 */
function advanceInsert(data: AdvanceJob, opts: AdvanceQueueOptions): JobInsert<AdvanceJob> {
  return { data, ...driveJobOptions(data.executionId, opts) }
}

/**
 * A resume signal (a resolved decision/approval, a chosen fork) can race the very advance job
 * that just parked the run. That job stays `active` until it acks, and the `exclusive` queue
 * makes a `send` with the same singletonKey an `ON CONFLICT DO NOTHING` no-op while it is —
 * so a bare re-`send` fired in that window is DROPPED and the resume is LOST, leaving the run
 * parked until the 5-minute stale-run sweeper notices (which for a `blocked` decision-park it
 * never does). This is the window a fast park→resume UI (and the back-to-back park→resume of
 * the approval / fork-decision flows) reliably hits. Advances are idempotent (advanceInstance
 * reads current state), so the resume enqueue RETRIES until the parking job acks and frees the
 * singletonKey (~sub-second) rather than dropping it — bounded so a genuinely long-running
 * active drive doesn't retry forever (past the budget the sweeper stays the backstop).
 */
const RESUME_ENQUEUE_RETRY_ATTEMPTS = 25
const RESUME_ENQUEUE_RETRY_INTERVAL_MS = 200

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class PgBossWorkRunner implements WorkRunner {
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly boss: PgBoss,
    private readonly queueOptions: AdvanceQueueOptions,
    // Test seam: override the retry delay (defaults to a real timer).
    options: { sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.sleep = options.sleep ?? realSleep
  }

  async startRun(workspaceId: string, executionId: string): Promise<void> {
    await this.boss.send(
      QUEUE,
      { workspaceId, executionId },
      sendOptions(executionId, this.queueOptions),
    )
  }

  async signalDecision(
    workspaceId: string,
    executionId: string,
    _decisionId: string,
    _choice: string,
  ): Promise<void> {
    // The decision is already persisted by resolveDecision; re-enqueue an advance so the
    // parked run resumes. The DB write is the source of truth, and the enqueue RETRIES past a
    // dedupe so a resume racing the parking job's ack is never lost (see the note above).
    await this.enqueueAdvanceReliably(workspaceId, executionId)
  }

  /**
   * Enqueue an advance for a resume, retrying while the exclusive queue dedupes it because the
   * run's parking advance job is still `active`. `boss.send` returns the new job id, or `null`
   * when the send was a singleton no-op; on `null` we wait for the parking job to ack (freeing
   * the singletonKey) and retry, so the resume can't be silently dropped into the sweeper's
   * multi-minute backstop. Idempotent, so at worst one redundant advance runs.
   */
  private async enqueueAdvanceReliably(workspaceId: string, executionId: string): Promise<void> {
    for (let attempt = 0; attempt < RESUME_ENQUEUE_RETRY_ATTEMPTS; attempt++) {
      const jobId = await this.boss.send(
        QUEUE,
        { workspaceId, executionId },
        sendOptions(executionId, this.queueOptions),
      )
      // A job id (accepted) — the advance will run. `null` means an advance job for this run is
      // still active; wait briefly for it to ack, then retry.
      if (jobId) return
      await this.sleep(RESUME_ENQUEUE_RETRY_INTERVAL_MS)
    }
    // Still deduped after the budget — a genuinely long active drive. The decision is persisted
    // and the stale-run sweeper re-drives a `running` run, so the resume is not lost, only slow.
  }

  async cancelRun(_workspaceId: string, _executionId: string): Promise<void> {
    // Best-effort: the run is finalized via ExecutionService.stopRun; any in-flight
    // advance job is a no-op once the run is terminal (advanceInstance returns noop).
  }
}

/**
 * Create the execution queue and start the worker that drives runs.
 *
 * `concurrency` (pg-boss `localConcurrency`) spawns that many INDEPENDENT workers for
 * the queue on this node: each polls, fetches one job (`batchSize` stays 1) and acks /
 * retries it on its own, so up to `concurrency` runs drive in parallel. This is the key
 * to throughput — a single drive parks for the whole of a step's poll budget (sleeping
 * between polls), so without parallel workers one slow run would block every other run
 * behind it. We deliberately keep `batchSize: 1` rather than raising it: a batch handler
 * completes/fails all its jobs together, which would couple unrelated runs' retries;
 * independent workers keep per-run retry semantics intact. The `exclusive` queue policy
 * still prevents the SAME run being driven by two workers at once (one live advance job per
 * run id; duplicate sends no-op). Scale `concurrency` with the DB pool
 * (each active drive borrows a connection only for its brief reads/writes between sleeps).
 */
export async function startExecutionWorker(
  boss: PgBoss,
  container: ServerContainer,
  cfg: DriveConfig,
  log: Logger,
  options: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = options.concurrency ?? 10
  await createQueueWithDeadLetter(boss, QUEUE, { policy: QUEUE_POLICY })
  await boss.work<AdvanceJob>(
    QUEUE,
    { localConcurrency: Math.max(1, concurrency) },
    async (jobs: Job<AdvanceJob>[]) => {
      for (const job of jobs) {
        const { workspaceId, executionId } = job.data
        try {
          // A parked run waits for a human indefinitely — it is never failed for waiting
          // (the old decision-timeout was removed). It simply parks here; `signalDecision`
          // re-enqueues an advance when the human resolves it, and the stale-run sweeper
          // leaves a `blocked` run alone. Urgency is conveyed by the escalating notification.
          const outcome = await driveExecution(
            container.executionService,
            workspaceId,
            executionId,
            cfg,
            { log },
          )
          // An unbounded-wait gate (human-review) released after one poll budget so this job
          // doesn't outlive its expire cap. The run stays `running`; the stale-run sweeper
          // re-enqueues a fresh advance for the next poll cycle (no in-handler re-send: the
          // `exclusive` queue would suppress it while this job is still active).
          if (outcome.rearmedGate) {
            log.info('human-review gate re-armed; awaiting sweep', { workspaceId, executionId })
          }
        } catch (error) {
          log.error('execution driver failed', {
            workspaceId,
            executionId,
            err: getErrorMessage(error),
          })
          throw error
        }
      }
    },
  )
}

/**
 * How often the stale-run sweeper runs, how stale a `running` run must be to re-drive, and
 * how long an orphaned run may stay unrecovered before it is failed as `stalled`.
 */
export interface SweeperConfig {
  intervalMs: number
  leaseMs: number
  /**
   * Hard deadline: a `running` execution this process has been UNABLE TO RECOVER for this
   * long (its advance job stays not-live across ticks despite re-driving) is failed `stalled`
   * rather than re-driven forever — so a run orphaned by a crashed orchestrator that recovery
   * can't resume stops spinning silently and surfaces (loudly) the failure banner + retry.
   *
   * The clock is per-PROCESS (measured from the first tick that observed the run orphaned),
   * NOT the raw lease age: a long orchestrator downtime inflates `updated_at`, so keying the
   * deadline off lease age would fail an otherwise-recoverable run on the very first boot tick
   * — before recovery was even attempted. Measuring from first-observed-orphaned excludes the
   * downtime and guarantees at least one re-drive attempt before giving up.
   */
  hardStallMs: number
}

/** Queue name carrying a run kind's durable advance/drive job. */
function queueForKind(kind: string): string | null {
  if (kind === 'execution') return QUEUE
  if (kind === 'bootstrap') return BOOTSTRAP_QUEUE
  if (kind === 'env-config-repair') return ENV_CONFIG_REPAIR_QUEUE
  return null
}

/** What {@link createStaleRunRecovery} needs, as bound callbacks over the facade's own wiring. */
interface StaleRunRecoveryDeps {
  boss: PgBoss
  jobs: JobStore
  /** Bump this run's persisted re-drive counter, returning the new total. */
  recordRedrive(workspaceId: string, id: string): Promise<number>
  /** Settle a run the recovery could not resume (the hard-stall backstop's terminal write). */
  failRun(workspaceId: string, executionId: string, message: string): Promise<void>
  /**
   * The drive key a stale BOOTSTRAP run is currently driven under. Injected rather than read off
   * a container here so the recovery stays a pure function of its ports; only the bootstrap flow
   * can differ from the run id (its apply phase is a second drive), so only it is asked.
   */
  bootstrapDriveId(workspaceId: string, id: string): Promise<string>
  hardStallMs: number
  /** A heartbeat older than this means a dead worker, not a long drive. */
  staleHeartbeatMs: number
  queueOptions: AdvanceQueueOptions
  /**
   * The sweeper's per-PROCESS "first observed orphaned" clock, keyed by run id, SHARED with the
   * caller: the recovery writes and prunes entries, and the caller's own prune loop reads it. Passed
   * in rather than owned here because its lifetime is the sweeper's, not one pass's.
   */
  orphanedSince: Map<string, number>
  log: Logger
  metrics: OperationalMetrics
}

/**
 * One tick's stale-run RECOVERY: classify each run's advance job, reclaim an orphaned one, apply the
 * hard-stall backstop, and re-drive per kind.
 *
 * Extracted from `startStaleRunSweeper` so the per-run isolation and the pass's own tally have a home
 * of their own; the sweeper it left behind owns the interval, the spend-paused resume and the health
 * report it builds from that tally.
 */
function createStaleRunRecovery(deps: StaleRunRecoveryDeps) {
  const { boss, jobs, hardStallMs, staleHeartbeatMs, queueOptions, orphanedSince, log, metrics } =
    deps
  // Count a re-drive, in memory and on the run itself. The persisted half is best-effort and
  // runs AFTER the re-enqueue: it is bookkeeping about the recovery and must never be able to
  // fail one, and a counter claiming a re-drive that did not happen is worse than a missed one.
  // The `orphanedSince` map answers "still orphaned this tick"; only the column survives a
  // restart, which is what makes "how many times has THIS run been re-driven" answerable.
  const countRedrive = async (ref: { workspaceId: string; id: string; kind: string }) => {
    metrics.increment('sweep.run_redriven', { kind: ref.kind })
    await runBestEffort(log, 'sweep.recordRedrive', () =>
      deps.recordRedrive(ref.workspaceId, ref.id),
    )
  }
  // Recover ONE stale run: reclaim an orphaned advance job, apply the hard-stall backstop, and
  // re-drive (per kind). Records into `keepOrphanClock` whether this run's per-process orphaned
  // clock must survive the tick (so the caller can forget the ones that recovered) and pushes an
  // execution re-drive into `advanceReenqueues` for the caller's single batch insert.
  const recoverStaleRun = async (
    ref: StaleAgentRun,
    now: number,
    keepOrphanClock: Set<string>,
    advanceReenqueues: JobInsert<AdvanceJob>[],
  ): Promise<void> => {
    const queue = queueForKind(ref.kind)
    if (!queue) return

    // Distinguish a healthy long drive (heartbeating) from an orphaned job whose worker
    // died, so we recover the orphan instead of silently no-op re-sending onto it.
    const { state, jobId } = await classifyAdvanceJob(jobs, queue, ref.id, staleHeartbeatMs, now)
    if (state === 'live') {
      orphanedSince.delete(ref.id)
      return
    }
    // Start (or carry forward) this run's per-process orphaned clock.
    const firstSeenOrphaned = orphanedSince.get(ref.id) ?? now
    orphanedSince.set(ref.id, firstSeenOrphaned)
    keepOrphanClock.add(ref.id)

    if (state === 'orphaned' && jobId) {
      log.warn('reclaiming orphaned advance job (dead worker) before re-drive', {
        workspaceId: ref.workspaceId,
        runId: ref.id,
        kind: ref.kind,
        jobId,
      })
      await reclaimAdvanceJob(boss, queue, jobId).catch((err) =>
        log.error('failed to reclaim orphaned advance job', {
          runId: ref.id,
          err: getErrorMessage(err),
        }),
      )
    }

    // Hard-stall backstop (execution only): a run this process has been unable to recover
    // for the whole deadline — re-driven on earlier ticks yet still not live — is failed
    // rather than left spinning `running`. Gated on the per-process clock (not lease age),
    // so a run first seen orphaned this tick (e.g. right after a long downtime) is always
    // re-driven at least once below before it can ever be given up on.
    if (ref.kind === 'execution' && now - firstSeenOrphaned > hardStallMs) {
      const mins = Math.round((now - ref.updatedAt) / 60_000)
      log.warn('run stalled past hard deadline; recovery could not resume it; failing', {
        workspaceId: ref.workspaceId,
        executionId: ref.id,
        staleMinutes: mins,
      })
      await deps.failRun(
        ref.workspaceId,
        ref.id,
        `Run stalled: no progress for ${mins} minutes and recovery could not resume it.`,
      )
      orphanedSince.delete(ref.id)
      keepOrphanClock.delete(ref.id)
      // The run KIND is a bounded enum and the split that matters: bootstrap runs and
      // execution runs are lost for different reasons and fixed in different places.
      metrics.increment('sweep.run_stalled', { kind: ref.kind })
      return
    }

    if (ref.kind === 'bootstrap') {
      // Re-drive under the run's CURRENT drive key: a monorepo run's apply phase is a second
      // drive with its own singleton key, and re-sending under the run id would be deduped
      // against the survey drive rather than reaching the one that is actually stuck.
      const driveId = await deps.bootstrapDriveId(ref.workspaceId, ref.id)
      log.warn('re-driving stale bootstrap', {
        workspaceId: ref.workspaceId,
        jobId: ref.id,
        driveId,
      })
      await reenqueueStaleBootstrap(boss, ref.workspaceId, ref.id, driveId, queueOptions)
      await countRedrive(ref)
      return
    }
    if (ref.kind === 'env-config-repair') {
      log.warn('re-driving stale env-config-repair', {
        workspaceId: ref.workspaceId,
        jobId: ref.id,
      })
      await reenqueueStaleEnvConfigRepair(boss, ref.workspaceId, ref.id, queueOptions)
      await countRedrive(ref)
      return
    }
    log.warn('re-driving stale run', { workspaceId: ref.workspaceId, executionId: ref.id })
    advanceReenqueues.push(
      advanceInsert({ workspaceId: ref.workspaceId, executionId: ref.id }, queueOptions),
    )
    await countRedrive(ref)
  }

  /**
   * Process one tick's stale runs, ONE RUN AT A TIME AND ISOLATED FROM EACH OTHER, and return how
   * many of them threw.
   *
   * The isolation is the point. Recovering a run touches the queue, the run row and (past the
   * hard-stall deadline) the execution service, so any single run can throw for reasons entirely
   * its own, and `listStale` is ordered OLDEST FIRST, so an unrecoverable run sorts to the front
   * of every future pass. Left to propagate, one such run does not merely fail to recover: it
   * ends the pass, taking with it every other stale run behind it, the spend-paused resumes and
   * the batch enqueue. The sweeper then looks healthy in the only way that is easy to check (it
   * is running) while recovering nothing at all.
   *
   * The COUNT is returned rather than merely logged because the pass's own health verdict turns on
   * it: a pass that took runs on and recovered none of them completes now, and the caller has to
   * report that as a failed pass rather than reset the `sweep_degraded` streak on it.
   */
  const recoverPass = async (
    stale: StaleAgentRun[],
    now: number,
    keepOrphanClock: Set<string>,
    advanceReenqueues: JobInsert<AdvanceJob>[],
  ): Promise<number> => {
    let failed = 0
    for (const ref of stale) {
      try {
        await recoverStaleRun(ref, now, keepOrphanClock, advanceReenqueues)
      } catch (error) {
        failed++
        log.error('stale-run recovery failed for one run; continuing the sweep', {
          workspaceId: ref.workspaceId,
          runId: ref.id,
          kind: ref.kind,
          ...describeError(error),
        })
        metrics.increment('sweep.run_recovery_failed', { kind: ref.kind })
        // This run made no OBSERVATION, so its orphan clock is carried forward rather than pruned
        // below. Nothing here claims it is still orphaned; the claim is only that nothing learned
        // otherwise, and the two are different from the prune loop's point of view. Left out, a
        // probe that throws every pass resets the hard-stall deadline every pass, and the backstop
        // that exists to settle an unrecoverable run could never fire. Before the isolation the
        // throw propagated and the prune loop was never reached, which preserved the clock by
        // accident; it has to be deliberate now.
        keepOrphanClock.add(ref.id)
      }
    }
    return failed
  }

  return { recoverPass }
}

/**
 * Backstop for runs still `running` in storage but whose durable advance job is gone or
 * orphaned (the worker crashed/was evicted). Mirrors — and now matches the recovery power
 * of — the Worker's cron `sweepStuckRuns`.
 *
 * Per stale run, the sweeper first classifies its advance job by pg-boss's own heartbeat
 * (see {@link classifyAdvanceJob}), because the `exclusive` queue makes a bare re-`send` a
 * no-op while ANY advance job exists — which previously left an ORPHANED-`active` run (job
 * stuck active, worker dead, heartbeat frozen) permanently un-recoverable by this sweeper:
 *
 * - `live`     — a real drive is running (or a job is queued to run). Leave it.
 * - `orphaned` — reclaim the dead job to free its singletonKey, then re-drive (or fail).
 * - `missing`  — re-drive directly.
 *
 * An execution this process has been unable to recover for `hardStallMs` (measured from the
 * first tick that saw it orphaned, so a long downtime doesn't count) is failed `stalled`
 * instead of re-driven forever, so an unrecoverable run doesn't spin `running` forever — but
 * every orphan still gets at least one re-drive attempt first. Decision-parked (`blocked`)
 * and spend-paused (`paused`) runs aren't `running`, so they're left alone. Returns a stop
 * function; also runs one tick immediately (boot reconcile — recover runs a crashed previous
 * process orphaned without waiting a full interval).
 */
export function startStaleRunSweeper(
  boss: PgBoss,
  jobs: JobStore,
  container: ServerContainer,
  cfg: SweeperConfig,
  queueOptions: AdvanceQueueOptions,
  // The logger, the counter and the sweep-health tracker travel together: every disposition
  // below is BOTH a line naming the run and a count under its kind, and a signature that could
  // carry one without the other is how a new disposition ends up logged and uncounted. `health`
  // is here for the same reason one rung up — this is a hand-rolled interval, so it reports its
  // own pass, and reporting only the counter left it out of the `sweep_degraded` streak.
  observability: { log: Logger; metrics: OperationalMetrics; health: SweepHealthTracker },
): () => void {
  const { log, metrics, health } = observability
  // A live drive heartbeats its active job every `heartbeatSeconds`; treat a heartbeat older
  // than a generous multiple of that (but at least the lease) as a dead worker.
  const staleHeartbeatMs = Math.max(cfg.leaseMs, queueOptions.heartbeatSeconds * 1000 * 3)
  // Per-PROCESS "first observed orphaned" clock, keyed by run id. The hard-stall deadline is
  // measured from this — NOT the raw lease age — so a long orchestrator downtime (which
  // inflates `updated_at`) can't fail an otherwise-recoverable run before recovery is even
  // attempted. Entries are dropped once a run recovers or leaves the stale set.
  const orphanedSince = new Map<string, number>()
  const { recoverPass } = createStaleRunRecovery({
    boss,
    jobs,
    recordRedrive: (workspaceId, id) => container.agentRunRepository.recordRedrive(workspaceId, id),
    failRun: (workspaceId, executionId, message) =>
      container.executionService.failRun(workspaceId, executionId, message, 'stalled', null),
    bootstrapDriveId: async (workspaceId, id) =>
      (await container.bootstrap?.service.driveIdOf(workspaceId, id)) ?? id,
    hardStallMs: cfg.hardStallMs,
    staleHeartbeatMs,
    queueOptions,
    orphanedSince,
    log,
    metrics,
  })
  // Auto-resume spend-paused runs once the monthly budget frees (parity with the Cloudflare
  // ExecutionWorkflow, whose parked instance re-checks the budget itself). `listStale` skips
  // `paused` runs, so re-check them here: re-drive ONLY those whose WORKSPACE and ACCOUNT
  // tiers are both back under budget — a still-exhausted workspace/account causes no churn.
  // Both are keyed only by the workspace (a workspace has one owning account), so the check
  // is cached per distinct workspace, not per run. The USER tier is deliberately NOT checked
  // here: it needs the run's initiator, which the lightweight paused ref doesn't carry, so a
  // run paused solely on a user cap is re-driven and the tier-aware step gate in
  // `ExecutionService.stepInstance` re-pauses it (a bounded, per-sweep one-step blip, not an
  // un-gated run). So this is a best-effort resume, not a proof the run will advance. Extracted
  // from the sweep tick to keep it under the statement ceiling; the body is unchanged.
  const resumePausedRuns = async (advanceReenqueues: JobInsert<AdvanceJob>[]): Promise<void> => {
    const paused = await container.agentRunRepository.listPausedExecutions()
    const exhaustedByWorkspace = new Map<string, boolean>()
    const accountByWorkspace = new Map<string, string | null>()
    for (const ref of paused) {
      let exhausted = exhaustedByWorkspace.get(ref.workspaceId)
      if (exhausted === undefined) {
        let accountId = accountByWorkspace.get(ref.workspaceId)
        if (accountId === undefined) {
          accountId = (await container.workspaceService.accountOf(ref.workspaceId)) ?? null
          accountByWorkspace.set(ref.workspaceId, accountId)
        }
        exhausted = await container.spendService.isOverBudget(ref.workspaceId, { accountId })
        exhaustedByWorkspace.set(ref.workspaceId, exhausted)
      }
      if (exhausted) continue
      log.info(
        're-driving spend-paused run (workspace/account budget free; step gate re-checks the user tier)',
        { workspaceId: ref.workspaceId, executionId: ref.id },
      )
      advanceReenqueues.push(
        advanceInsert({ workspaceId: ref.workspaceId, executionId: ref.id }, queueOptions),
      )
    }
  }

  const tick = async () => {
    try {
      const now = Date.now()
      const stale = await container.agentRunRepository.listStale(now - cfg.leaseMs)
      // Which runs' per-process orphaned clock survives this tick: the ones observed still orphaned,
      // plus the ones nothing could observe because their own recovery threw.
      const keepOrphanClock = new Set<string>()
      // Every `execution.advance` re-drive this tick decides on — stale re-drives AND spend-paused
      // resumes — is gathered here and flushed as ONE batch `insert` instead of a `send` per run.
      // singletonKeys are distinct across the batch (a run is either `running`/stale or `paused`,
      // never both in one tick), so no row conflicts with another in the same insert; each
      // conflicts only with its own already-live advance job, which the exclusive index no-ops per
      // row. (Bootstrap / env-config-repair re-drives target other queues via their own helpers and
      // are left as individual sends — different queue, typically N=1.)
      const advanceReenqueues: JobInsert<AdvanceJob>[] = []
      const failed = await recoverPass(stale, now, keepOrphanClock, advanceReenqueues)
      // Forget runs that recovered (bumped their lease → left the stale set) or went terminal,
      // so their per-process orphaned clock restarts if they ever stall again.
      for (const id of orphanedSince.keys()) {
        if (!keepOrphanClock.has(id)) orphanedSince.delete(id)
      }
      await resumePausedRuns(advanceReenqueues)
      // One batch insert for every execution.advance re-drive gathered this tick (stale
      // re-drives + spend-paused resumes), replacing N per-run `send` round-trips.
      if (advanceReenqueues.length > 0) await boss.insert(QUEUE, advanceReenqueues)
      // A pass that took runs on and recovered NONE of them is reported as a failed pass, not a
      // successful one: per-run isolation means such a pass now resolves, and recording a success
      // would reset the `sweep_degraded` streak on exactly the wedged sweeper it watches for.
      if (sweepPassRecoveredNothing({ attempted: stale.length, failed })) {
        log.error('stale-run sweep recovered none of the runs it took on', {
          attempted: stale.length,
          failed,
        })
        health.recordFailure('stale-run')
      } else {
        health.recordSuccess('stale-run')
      }
    } catch (error) {
      log.error('stale-run sweep failed', {
        err: getErrorMessage(error),
      })
      // This sweeper predates `startSweeper` (it is a hand-rolled interval, because a boot
      // reconcile has to run before the first tick), so it reports its own pass under the same
      // `sweep` dimension the shared helper uses.
      health.recordFailure('stale-run')
    }
  }
  // Boot reconcile: recover runs a crashed previous process orphaned right away, not after
  // one full interval (the incident that motivated this: a restart left a run frozen).
  void tick()
  const timer = setInterval(() => void tick(), cfg.intervalMs)
  timer.unref?.() // never keep the process alive on the sweep timer alone
  return () => clearInterval(timer)
}
