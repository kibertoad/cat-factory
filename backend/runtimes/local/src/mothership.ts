import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { type CoreRepositories, type DriveConfig, driveExecution } from '@cat-factory/node-server'
import {
  HttpPersistenceRpcClient,
  type Logger,
  createRemoteRepositoryRegistry,
} from '@cat-factory/server'
import type { WorkRunner } from '@cat-factory/kernel'
import { type LocalCredentialStore, createLocalCredentialStore } from './sqlite/credentialStore.js'
import { SqliteWorkQueue, createWorkQueue } from './sqlite/workQueue.js'

// Mothership mode (docs/initiatives/mothership-mode.md): the local node keeps NO main
// database. Org/durable state lives on a hosted "mothership" cat-factory (Node or Cloudflare)
// and is reached over the authenticated `/internal/persistence` machine API; agent/model
// CREDENTIALS stay on the laptop in a file-based `node:sqlite` store, sealed with the LOCAL
// key (the mothership's ENCRYPTION_KEY never reaches the machine). This module composes those
// two halves into the seams `buildLocalContainer` threads into `buildNodeContainer`, and
// supplies the in-process work runner that replaces pg-boss when there is no Postgres.

/** True when this local node should boot in mothership mode (a mothership URL is configured). */
export function isMothershipMode(env: NodeJS.ProcessEnv): boolean {
  return !!env.LOCAL_MOTHERSHIP_URL?.trim()
}

/** Resolve the on-disk path for the local credential SQLite store (`:memory:` honoured for tests). */
function credentialDbPath(env: NodeJS.ProcessEnv): string {
  return localDbPath(env.LOCAL_MOTHERSHIP_CREDENTIAL_DB, 'credentials.sqlite')
}

/** Resolve the on-disk path for the durable execution work queue (`:memory:` honoured for tests). */
function workQueueDbPath(env: NodeJS.ProcessEnv): string {
  return localDbPath(env.LOCAL_MOTHERSHIP_WORK_DB, 'work-queue.sqlite')
}

/**
 * Resolve a local SQLite file path: an explicit override wins (incl. `:memory:` for tests), else a
 * stable per-user file under `~/.cat-factory` so the store survives restarts (the whole point of a
 * durable local store). Ensures the directory exists.
 */
function localDbPath(explicit: string | undefined, fileName: string): string {
  const override = explicit?.trim()
  if (override) return override
  const dir = join(homedir(), '.cat-factory')
  mkdirSync(dir, { recursive: true })
  return join(dir, fileName)
}

/** The composed mothership persistence: remote org repos + the local credential store. */
export interface MothershipComposition {
  /**
   * The full {@link CoreRepositories} surface, every entry remote (RPC-backed). The pilot
   * allow-list gates which repo+method actually executes on the mothership; an
   * un-allow-listed call returns `unknown_method`. IMPORTANT: the pilot table exposes only the
   * six core domain repos, which is NOT enough for a board load or a run end-to-end — those
   * touch many more repos (mounts, settings, presets, notifications, …) that are still
   * un-allow-listed (and the direct-db repos in `buildNodeContainer` have no db here), so they
   * currently throw. The widened surface is the gating phase in docs/initiatives/mothership-mode.md
   * (this PR must stay a draft until it lands).
   */
  repos: CoreRepositories
  /** The local-sqlite credential store (kept on the laptop, sealed with the local key). */
  credentialStore: LocalCredentialStore
  /** The durable local-sqlite execution work queue (the no-pg-boss durability substrate). */
  workQueue: SqliteWorkQueue
  /** Close the underlying SQLite databases (call on shutdown). */
  close(): void
}

/**
 * Compose the mothership persistence from env. Builds the machine-authed RPC client +
 * the full remote repository registry, and opens the local credential store. The caller
 * (`buildLocalContainer`) passes `repos` as `options.repos` and the credential store's two
 * repositories as `options.providerApiKeyRepository` / `options.localModelEndpointRepository`,
 * with `options.db` left undefined.
 *
 * Throws when `LOCAL_MOTHERSHIP_TOKEN` is missing — a mothership URL with no machine token
 * cannot authenticate a single call, so fail fast at boot rather than 403 on first read.
 */
export function composeMothership(env: NodeJS.ProcessEnv): MothershipComposition {
  const baseUrl = env.LOCAL_MOTHERSHIP_URL?.trim()
  if (!baseUrl) {
    throw new Error('composeMothership called without LOCAL_MOTHERSHIP_URL set')
  }
  const token = env.LOCAL_MOTHERSHIP_TOKEN?.trim()
  if (!token) {
    throw new Error(
      'LOCAL_MOTHERSHIP_URL is set but LOCAL_MOTHERSHIP_TOKEN is not. A mothership-mode node ' +
        'authenticates every persistence call with a machine token minted by the mothership; ' +
        'set LOCAL_MOTHERSHIP_TOKEN and restart. (Login-based minting lands in a later slice.)',
    )
  }
  const client = new HttpPersistenceRpcClient({ baseUrl, token })
  const repos = createRemoteRepositoryRegistry(client) as unknown as CoreRepositories
  const credentialStore = createLocalCredentialStore(credentialDbPath(env))
  const workQueue = createWorkQueue(workQueueDbPath(env))
  return {
    repos,
    credentialStore,
    workQueue,
    close: () => {
      credentialStore.close()
      workQueue.close()
    },
  }
}

type ExecutionService = Parameters<typeof driveExecution>[0]

/** Timing + sizing knobs for the durable work runner, derived from the execution runtime config. */
export interface SqliteWorkRunnerOptions {
  /** The advance/poll drive config (poll intervals + budgets). */
  drive: DriveConfig
  /** Lease for an in-flight drive; an `active` row past it is treated as crash-orphaned. */
  leaseMs: number
  /** Delay before re-polling a re-armed unbounded gate (≈ the gate poll interval). */
  reArmDelayMs: number
  /** Backoff before retrying a drive that threw. */
  errorBackoffMs: number
  /** Periodic recovery poll: reclaim queued + lease-expired rows (the crash-recovery backstop). */
  sweepIntervalMs: number
  /** Max drive attempts before a poison run is evicted (parity with pg-boss `retryLimit`). */
  maxAttempts: number
  /** How many runs to drive in parallel on this node (parity with pg-boss worker concurrency). */
  concurrency: number
}

/**
 * The durable SQLite-backed work runner: the no-Postgres analogue of {@link PgBossWorkRunner}. A
 * mothership-mode node has no pg-boss, so it drives runs in this process — but unlike PR 1's
 * best-effort in-memory runner, the intent "this run needs driving" is persisted in a local
 * `node:sqlite` {@link SqliteWorkQueue}, so a crash or restart re-drives what was in flight. It
 * mirrors pg-boss's `exclusive` advance queue:
 *
 *   - one row per run (the queue's PRIMARY KEY) = pg-boss's `singletonKey` dedup;
 *   - a `startRun` / `signalDecision` (re)queues the run and kicks the drain loop;
 *   - the drain loop claims drivable runs up to `concurrency` and drives each via the SAME
 *     `driveExecution` advance/poll loop the Node facade uses (real timer-backed sleeps);
 *   - a signal arriving mid-drive coalesces into exactly one follow-up via the row's `rerun` flag;
 *   - a re-armed unbounded gate (human review) is deferred for `reArmDelayMs` then re-polled — the
 *     in-process analogue of the stale-run sweeper re-enqueuing it;
 *   - a periodic recovery poll + a boot-time orphan reset reclaim runs left `active` by a dead
 *     process (the durability pg-boss gets from Postgres, here from the SQLite file).
 *
 * The execution service is bound after the container is built (it does not exist when the runner is
 * constructed). The `running` set tracks which runs THIS process is driving, so the claim loop and
 * the recovery poll never double-drive an in-flight run.
 */
export class SqliteWorkRunner implements WorkRunner {
  private exec?: ExecutionService
  private readonly running = new Set<string>()
  private sweepTimer?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(
    private readonly queue: SqliteWorkQueue,
    private readonly opts: SqliteWorkRunnerOptions,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Bind the execution service once the container is built, recover any runs orphaned by a previous
   * process, drive what's queued, and start the periodic recovery poll. Idempotent / safe to call
   * once per runner.
   */
  bind(exec: ExecutionService): void {
    this.exec = exec
    // Boot recovery: any row left `active` was orphaned when a previous process died (this process
    // drives nothing yet), so reclaim it for an immediate re-drive.
    const orphans = this.queue.resetOrphans()
    if (orphans > 0) {
      this.log.warn(
        { orphans },
        'mothership work queue: re-driving runs orphaned by a prior process',
      )
    }
    this.drain()
    // Backstop for runs whose deferred re-arm / error-backoff kick was lost, or whose lease lapsed:
    // a periodic drain reclaims every queued + lease-expired row. Unref'd so it never holds the
    // process open on its own.
    this.sweepTimer = setInterval(() => this.drain(), this.opts.sweepIntervalMs)
    this.sweepTimer.unref?.()
  }

  /** Stop the recovery poll (shutdown). In-flight drives are left to finish or die with the process. */
  stop(): void {
    this.stopped = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  async startRun(workspaceId: string, executionId: string): Promise<void> {
    this.wake(workspaceId, executionId)
  }

  async signalDecision(workspaceId: string, executionId: string): Promise<void> {
    // The decision is already persisted (to the mothership); (re)queue so the parked run resumes.
    this.wake(workspaceId, executionId)
  }

  async cancelRun(): Promise<void> {
    // Best-effort: the run is finalized via ExecutionService.stopRun; an in-flight drive is a
    // no-op once the run is terminal (advanceInstance returns noop), and its row is settled away.
  }

  /**
   * (Re)queue a run and kick the drain loop. If a drive is already in flight for it, flag the row
   * for a coalesced re-drive (the finishing driver re-queues it); otherwise force it claimable now
   * (covers a fresh run, an idle run, and waking a deferred gate re-poll early). The `running` set
   * read is race-free: a drive only reaches `settle` synchronously between awaits, with the run
   * still in `running`, so an in-flight run is never misclassified as idle.
   */
  private wake(workspaceId: string, executionId: string): void {
    if (this.running.has(executionId)) {
      this.queue.markRerun(executionId)
    } else {
      this.queue.enqueue(workspaceId, executionId, this.now())
    }
    this.drain()
  }

  /** Claim and launch drives up to the concurrency cap. Synchronous; each drive re-drains on finish. */
  private drain(): void {
    if (!this.exec || this.stopped) return
    while (this.running.size < this.opts.concurrency) {
      const job = this.queue.claim(
        this.now(),
        this.opts.leaseMs,
        this.opts.maxAttempts,
        this.running,
      )
      if (!job) break
      void this.driveClaimed(job.workspaceId, job.executionId)
    }
  }

  private async driveClaimed(workspaceId: string, executionId: string): Promise<void> {
    const exec = this.exec
    if (!exec) return
    this.running.add(executionId)
    try {
      const outcome = await driveExecution(exec, workspaceId, executionId, this.opts.drive, {
        log: this.log,
      })
      // Shutting down: don't touch the (closing) queue; the in-memory cleanup below still runs.
      if (this.stopped) return
      if (outcome.rearmedGate) {
        // A re-armed unbounded-wait gate (human review) released without finishing. Hold the run
        // off the claim queue until the gate's poll interval, then re-poll — the in-process
        // analogue of the sweeper re-enqueuing it. The future lease doubles as crash recovery.
        this.queue.defer(executionId, this.now() + this.opts.reArmDelayMs)
        this.scheduleKick(this.opts.reArmDelayMs)
      } else {
        // Standstill (or a coalesced signal): settle deletes the row, or re-queues it for one more
        // drive — the trailing drain() below picks the re-queued run straight back up.
        this.queue.settle(executionId)
      }
    } catch (err) {
      if (this.stopped) return
      this.log.error(
        { workspaceId, executionId, err: err instanceof Error ? err.message : String(err) },
        'mothership in-process execution driver failed',
      )
      // Hold the run for a backoff'd retry; the attempts cap evicts a genuinely poison run.
      this.queue.defer(executionId, this.now() + this.opts.errorBackoffMs)
      this.scheduleKick(this.opts.errorBackoffMs)
    } finally {
      this.running.delete(executionId)
    }
    // Pick up a coalesced re-drive of this run plus any other queued run a freed slot now allows.
    this.drain()
  }

  /** Re-run the drain loop after `delayMs` (a deferred gate re-poll / error backoff). Unref'd. */
  private scheduleKick(delayMs: number): void {
    const timer = setTimeout(() => this.drain(), Math.max(1, delayMs))
    timer.unref?.()
  }
}
