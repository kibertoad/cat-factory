import type { WorkRunner } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { Job, PgBoss, SendOptions } from 'pg-boss'
import { reenqueueStaleBootstrap } from './bootstrapRunner.js'
import { type DriveConfig, driveExecution } from './drive.js'

// Durable execution on pg-boss: the analogue of the Worker's Cloudflare Workflows
// driver. `startRun` enqueues an advance job (deduped per run via singletonKey); a
// registered worker drives the run to a standstill via `driveExecution`. A resolved
// decision re-enqueues an advance to resume a parked run. State lives in Postgres,
// so a crash mid-run is recovered two ways: pg-boss retries an expired/failed advance
// job, and the stale-run sweeper re-enqueues runs still `running` in storage.

const QUEUE = 'execution.advance'
// A separate, delayed queue that fails a run still parked on a decision after the
// `decisionTimeout` window — the Node analogue of the Cloudflare driver's
// `waitForEvent(..., { timeout })`. Kept off the advance queue so the delay never holds
// up real drives, and `exclusive` so at most one pending timeout exists per (run, decision).
const DECISION_TIMEOUT_QUEUE = 'execution.decision-timeout'

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

interface DecisionTimeoutJob {
  workspaceId: string
  executionId: string
  decisionId: string
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
 * `expireInSeconds` cap. `retryLimit`/`retryBackoff` make pg-boss itself re-drive a job
 * that throws, expires, or misses its heartbeat (a crashed worker) — the durable backstop.
 * See `executionRuntime` for how both are sized.
 */
export interface AdvanceQueueOptions {
  expireInSeconds: number
  heartbeatSeconds: number
  retryLimit: number
  retryDelaySeconds: number
}

function sendOptions(executionId: string, opts: AdvanceQueueOptions): SendOptions {
  return {
    singletonKey: executionId,
    expireInSeconds: opts.expireInSeconds,
    heartbeatSeconds: opts.heartbeatSeconds,
    retryLimit: opts.retryLimit,
    retryDelay: opts.retryDelaySeconds,
    retryBackoff: true,
  }
}

export class PgBossWorkRunner implements WorkRunner {
  constructor(
    private readonly boss: PgBoss,
    private readonly queueOptions: AdvanceQueueOptions,
  ) {}

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
    // The decision is already persisted by resolveDecision; re-enqueue an advance so
    // the parked run resumes. The DB write is the source of truth either way.
    await this.boss.send(
      QUEUE,
      { workspaceId, executionId },
      sendOptions(executionId, this.queueOptions),
    )
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
  options: { concurrency?: number; decisionTimeoutSeconds?: number } = {},
): Promise<void> {
  const concurrency = options.concurrency ?? 10
  const decisionTimeoutSeconds = options.decisionTimeoutSeconds ?? 0
  await boss.createQueue(QUEUE, { policy: QUEUE_POLICY })
  await boss.work<AdvanceJob>(
    QUEUE,
    { localConcurrency: Math.max(1, concurrency) },
    async (jobs: Job<AdvanceJob>[]) => {
      for (const job of jobs) {
        const { workspaceId, executionId } = job.data
        try {
          const outcome = await driveExecution(
            container.executionService,
            workspaceId,
            executionId,
            cfg,
            { log },
          )
          // Arm a decision timeout when the run parked awaiting a human. There is no
          // event to cancel it on resolution (unlike Cloudflare's waitForEvent), so the
          // timeout job re-checks state and `expireDecision` no-ops if it was resolved.
          if (outcome.parkedDecisionId && decisionTimeoutSeconds > 0) {
            await boss.send(
              DECISION_TIMEOUT_QUEUE,
              { workspaceId, executionId, decisionId: outcome.parkedDecisionId },
              {
                startAfter: decisionTimeoutSeconds,
                singletonKey: `${executionId}:${outcome.parkedDecisionId}`,
              },
            )
          }
        } catch (error) {
          log.error(
            {
              workspaceId,
              executionId,
              err: error instanceof Error ? error.message : String(error),
            },
            'execution driver failed',
          )
          throw error
        }
      }
    },
  )
}

/**
 * Start the worker that expires overdue decisions. A delayed job (armed by
 * {@link startExecutionWorker} when a run parks on a decision) fires after the
 * `decisionTimeout`; `expireDecision` fails the run as `decision_timeout` ONLY if it is
 * still parked on that exact decision, so a decision resolved meanwhile is a safe no-op
 * (no driving — that stays on the advance queue). This is the Node analogue of the
 * Cloudflare driver's `waitForEvent` timeout. Create the queue before the advance worker
 * so the advance worker's `boss.send` to it always has a target.
 */
export async function startDecisionTimeoutWorker(
  boss: PgBoss,
  container: ServerContainer,
  log: Logger,
): Promise<void> {
  await boss.createQueue(DECISION_TIMEOUT_QUEUE, { policy: QUEUE_POLICY })
  await boss.work<DecisionTimeoutJob>(
    DECISION_TIMEOUT_QUEUE,
    async (jobs: Job<DecisionTimeoutJob>[]) => {
      for (const job of jobs) {
        const { workspaceId, executionId, decisionId } = job.data
        try {
          await container.executionService.expireDecision(workspaceId, executionId, decisionId)
        } catch (error) {
          log.error(
            {
              workspaceId,
              executionId,
              decisionId,
              err: error instanceof Error ? error.message : String(error),
            },
            'decision-timeout check failed',
          )
          throw error
        }
      }
    },
  )
}

/** How often the stale-run sweeper runs, and how stale a `running` run must be to re-drive. */
export interface SweeperConfig {
  intervalMs: number
  leaseMs: number
}

/**
 * Backstop for runs that are still `running` in storage but whose advance job is gone
 * (the worker crashed/was evicted before the job retried). Mirrors the Worker's cron
 * `sweepStuckRuns`: on each tick it re-enqueues every stale `running` execution run.
 * The re-enqueue carries the run's `singletonKey` and the queue is `exclusive`, so a run
 * that IS still being driven (its advance job active/retrying) is a silent no-op — only
 * genuinely orphaned runs re-drive.
 * Decision-parked (`blocked`) and spend-paused (`paused`) runs aren't `running`, so the
 * sweeper leaves them alone. Returns a stop function (clears the interval).
 */
export function startStaleRunSweeper(
  boss: PgBoss,
  container: ServerContainer,
  cfg: SweeperConfig,
  queueOptions: AdvanceQueueOptions,
  log: Logger,
): () => void {
  const tick = async () => {
    try {
      const stale = await container.agentRunRepository.listStale(Date.now() - cfg.leaseMs)
      for (const ref of stale) {
        // Both durable kinds are re-driven: an orphaned execution back onto the advance
        // queue, an orphaned bootstrap onto the bootstrap drive queue (parity with the
        // Worker's sweepStuckRuns, which covers execution + bootstrap).
        if (ref.kind === 'bootstrap') {
          log.warn({ workspaceId: ref.workspaceId, jobId: ref.id }, 're-driving stale bootstrap')
          await reenqueueStaleBootstrap(boss, ref.workspaceId, ref.id, queueOptions)
          continue
        }
        if (ref.kind !== 'execution') continue
        log.warn({ workspaceId: ref.workspaceId, executionId: ref.id }, 're-driving stale run')
        await boss.send(
          QUEUE,
          { workspaceId: ref.workspaceId, executionId: ref.id },
          sendOptions(ref.id, queueOptions),
        )
      }
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'stale-run sweep failed',
      )
    }
  }
  const timer = setInterval(() => void tick(), cfg.intervalMs)
  timer.unref?.() // never keep the process alive on the sweep timer alone
  return () => clearInterval(timer)
}
