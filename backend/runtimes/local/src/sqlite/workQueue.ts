import { DatabaseSync } from 'node:sqlite'

// The mothership-mode DURABLE execution work queue.
//
// A mothership-mode local node has no Postgres and therefore no pg-boss, so it cannot use the
// Node facade's `PgBossWorkRunner`. PR 1 shipped a best-effort `InProcessWorkRunner` whose
// "queue" lived only in memory — a crash or restart lost every in-flight drive, and there was
// no stale-run recovery (the NOTE that runner carried). This module is the durable replacement
// (initiative PR 2): a file-based `node:sqlite` queue that persists the intent "this run needs
// driving", so a restart re-drives what was in flight, mirroring the durability pg-boss gives the
// Node facade. It belongs to the local-sqlite bucket (docs/initiatives/mothership-mode.md) — a
// local-facade-only differentiator with no cross-runtime symmetry obligation.
//
// `node:sqlite`'s `DatabaseSync` is synchronous and single-process, so every method here runs to
// completion with no other JavaScript interleaving — a select-then-update is inherently atomic,
// which is exactly the property pg-boss buys with row locks. The semantics mirror pg-boss's
// `exclusive` advance queue:
//   - `execution_id` is the PRIMARY KEY, so there is at most one row per run — the equivalent of
//     pg-boss's `singletonKey` dedup (a re-enqueue for a run already queued is a no-op).
//   - a row is `queued` (needs a drive, free to claim) or `active` (being driven; `lease_until`
//     is the crash-detection deadline). `rerun` records that a signal arrived mid-drive so the
//     finishing driver re-queues exactly once (coalescing), like the in-memory runner did.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS execution_work_queue (
  execution_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  rerun INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_work_queue_claimable
  ON execution_work_queue (state, lease_until, enqueued_at);
`

/** Open (creating if absent) the work-queue SQLite database and ensure its schema. */
export function openWorkQueueDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  // Mirror the credential store's pragmas: WAL keeps the single writer from blocking readers,
  // and the busy timeout absorbs a brief lock instead of throwing SQLITE_BUSY.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}

/** A run claimed for driving. `attempts` is the post-claim count (1 on the first drive). */
export interface ClaimedRun {
  workspaceId: string
  executionId: string
  attempts: number
}

interface ClaimRow {
  execution_id: string
  workspace_id: string
  attempts: number
}

/**
 * The durable SQLite-backed execution queue. All methods are synchronous (`node:sqlite`); the
 * runner wraps them in the `WorkRunner` async surface. The class is pure persistence — no timers,
 * no driving — so it can be unit-tested against an in-memory database.
 */
export class SqliteWorkQueue {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * (Re)queue a run so it is claimable now. New → a `queued` row; on conflict the row is forced
   * back to `queued` with its lease cleared (so an idle, or a deferred gate-repoll, row becomes
   * immediately drivable). `attempts` is preserved so a run's retry budget survives a re-trigger.
   *
   * The caller (`SqliteWorkRunner`) only calls this for a run it knows is NOT being driven in this
   * process; a signal that arrives mid-drive goes through {@link markRerun} instead, so this never
   * disturbs a genuinely in-flight drive's row.
   */
  enqueue(workspaceId: string, executionId: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO execution_work_queue
           (execution_id, workspace_id, state, rerun, lease_until, attempts, enqueued_at)
         VALUES (?, ?, 'queued', 0, 0, 0, ?)
         ON CONFLICT(execution_id) DO UPDATE SET
           state = 'queued',
           rerun = 0,
           lease_until = 0`,
      )
      .run(executionId, workspaceId, now)
  }

  /**
   * Flag an in-flight drive so the finishing driver re-queues the run exactly once (the coalescing
   * the in-memory runner did with its `rerun` map). Only ever called while the run's row is
   * `active`; returns true if it matched (it always does under that invariant — kept as a guard).
   */
  markRerun(executionId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE execution_work_queue SET rerun = 1 WHERE execution_id = ? AND state = 'active'`,
      )
      .run(executionId)
    return Number(res.changes) > 0
  }

  /**
   * Reset every `active` row to `queued`. Boot recovery: a freshly started process drives nothing
   * yet, so any row left `active` was orphaned when a previous process died — reclaim it for an
   * immediate re-drive (the durable analogue of pg-boss retrying a crashed worker's job). Returns
   * how many runs were recovered.
   */
  resetOrphans(): number {
    const res = this.db
      .prepare(
        `UPDATE execution_work_queue SET state = 'queued', lease_until = 0 WHERE state = 'active'`,
      )
      .run()
    return Number(res.changes)
  }

  /**
   * Claim the oldest drivable run, or null if none. Drivable = `queued`, or `active` whose lease
   * has expired (a drive orphaned by a crash, recovered once the lease lapses). Runs in `exclude`
   * (being driven in THIS process) are skipped, and a run past `maxAttempts` is evicted as a poison
   * pill rather than re-driven forever. The claim marks the row `active` with a fresh lease and
   * bumps `attempts`, so the row is non-claimable again the instant this returns.
   */
  claim(
    now: number,
    leaseMs: number,
    maxAttempts: number,
    exclude: ReadonlySet<string>,
  ): ClaimedRun | null {
    const rows = this.db
      .prepare(
        `SELECT execution_id, workspace_id, attempts FROM execution_work_queue
         WHERE state = 'queued' OR (state = 'active' AND lease_until <= ?)
         ORDER BY enqueued_at ASC`,
      )
      .all(now) as unknown as ClaimRow[]
    for (const row of rows) {
      if (exclude.has(row.execution_id)) continue
      if (row.attempts >= maxAttempts) {
        this.db
          .prepare('DELETE FROM execution_work_queue WHERE execution_id = ?')
          .run(row.execution_id)
        continue
      }
      this.db
        .prepare(
          `UPDATE execution_work_queue
             SET state = 'active', rerun = 0, lease_until = ?, attempts = attempts + 1
           WHERE execution_id = ?`,
        )
        .run(now + leaseMs, row.execution_id)
      return {
        workspaceId: row.workspace_id,
        executionId: row.execution_id,
        attempts: row.attempts + 1,
      }
    }
    return null
  }

  /**
   * Settle a finished drive: if a signal arrived mid-drive (`rerun`), re-queue the run for one more
   * drive and report `requeued: true`; otherwise the run reached a standstill, so delete its row.
   */
  settle(executionId: string): { requeued: boolean } {
    const row = this.db
      .prepare('SELECT rerun FROM execution_work_queue WHERE execution_id = ?')
      .get(executionId) as { rerun: number } | undefined
    if (row && row.rerun) {
      this.db
        .prepare(
          `UPDATE execution_work_queue SET state = 'queued', rerun = 0, lease_until = 0 WHERE execution_id = ?`,
        )
        .run(executionId)
      return { requeued: true }
    }
    this.db.prepare('DELETE FROM execution_work_queue WHERE execution_id = ?').run(executionId)
    return { requeued: false }
  }

  /**
   * Keep a run but hold it off the claim queue until `notBefore`, by leaving it `active` with a
   * future lease. Used for a re-armed unbounded gate (re-poll after the gate interval) and for an
   * errored drive (retry after a backoff) — in both cases the lease doubles as crash recovery: if
   * the process dies during the wait, the lease lapses and the run is reclaimed.
   */
  defer(executionId: string, notBefore: number): void {
    this.db
      .prepare(
        `UPDATE execution_work_queue SET state = 'active', rerun = 0, lease_until = ? WHERE execution_id = ?`,
      )
      .run(notBefore, executionId)
  }

  /** Count rows, optionally filtered by state (for tests / observability). */
  size(state?: 'queued' | 'active'): number {
    const row = state
      ? this.db.prepare('SELECT COUNT(*) AS n FROM execution_work_queue WHERE state = ?').get(state)
      : this.db.prepare('SELECT COUNT(*) AS n FROM execution_work_queue').get()
    return Number((row as { n: number }).n)
  }

  close(): void {
    this.db.close()
  }
}

/** Open the work queue at `path` (a file under the developer's config dir, or `:memory:` in tests). */
export function createWorkQueue(path: string): SqliteWorkQueue {
  return new SqliteWorkQueue(openWorkQueueDb(path))
}
