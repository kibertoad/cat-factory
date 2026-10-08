import type { DatabaseSync } from 'node:sqlite'
import { guidedReviewJobKey, type GuidedReviewJob } from '@cat-factory/kernel'
import { openSqliteDb, queryAll, queryOne } from './db.js'

// The mothership-mode durable queue for guided-review jobs: the local stand-in for pg-boss's
// `guided-review.run` queue, shaped like `SqliteWorkQueue`. It persists only the intent "this job
// needs driving"; the job's state lives on the mothership through the remote repository, and
// `GuidedReviewService.runJob` claims there before any model call. `node:sqlite` is synchronous,
// so each method runs to completion with nothing interleaving.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guided_review_queue (
  job_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  job TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guided_review_queue_claimable
  ON guided_review_queue (state, lease_until, enqueued_at);
`

export interface ClaimedGuidedReviewJob {
  key: string
  workspaceId: string
  job: GuidedReviewJob
  /** Consecutive failed drives before this claim. */
  attempts: number
}

interface QueueRow {
  job_key: string
  workspace_id: string
  job: string
  attempts: number
}

function toClaimed(row: QueueRow): ClaimedGuidedReviewJob {
  return {
    key: row.job_key,
    workspaceId: row.workspace_id,
    job: JSON.parse(row.job) as GuidedReviewJob,
    attempts: row.attempts,
  }
}

export class SqliteGuidedReviewQueue {
  constructor(private readonly db: DatabaseSync) {}

  /** Queue a job. A job already queued or being driven keeps its one row. */
  enqueue(workspaceId: string, job: GuidedReviewJob, now: number): void {
    this.db
      .prepare(
        `INSERT INTO guided_review_queue (job_key, workspace_id, job, state, enqueued_at)
         VALUES (?, ?, ?, 'queued', ?)
         ON CONFLICT(job_key) DO NOTHING`,
      )
      .run(guidedReviewJobKey(job), workspaceId, JSON.stringify(job), now)
  }

  /** Boot recovery: nothing is being driven yet, so every `active` row was orphaned. */
  resetOrphans(): number {
    const res = this.db
      .prepare(
        `UPDATE guided_review_queue SET state = 'queued', lease_until = 0 WHERE state = 'active'`,
      )
      .run()
    return Number(res.changes)
  }

  /**
   * Claim the oldest drivable job (queued, or active past its lease), skipping `exclude` (jobs this
   * process is driving right now), or null.
   */
  claim(now: number, leaseMs: number, exclude: ReadonlySet<string>): ClaimedGuidedReviewJob | null {
    const rows = queryAll<QueueRow>(
      this.db,
      `SELECT job_key, workspace_id, job, attempts FROM guided_review_queue
         WHERE state = 'queued' OR (state = 'active' AND lease_until <= ?)
         ORDER BY enqueued_at ASC`,
      now,
    )
    const row = rows.find((r) => !exclude.has(r.job_key))
    if (!row) return null
    this.db
      .prepare(`UPDATE guided_review_queue SET state = 'active', lease_until = ? WHERE job_key = ?`)
      .run(now + leaseMs, row.job_key)
    return toClaimed(row)
  }

  /** The drive finished: the job is settled on the mothership, so the intent is spent. */
  complete(key: string): void {
    this.db.prepare('DELETE FROM guided_review_queue WHERE job_key = ?').run(key)
  }

  /** The drive threw: hold the job off the queue until `notBefore` and count the failure. */
  deferFailure(key: string, notBefore: number): void {
    this.db
      .prepare(
        `UPDATE guided_review_queue SET state = 'active', lease_until = ?, attempts = attempts + 1
         WHERE job_key = ?`,
      )
      .run(notBefore, key)
  }

  /**
   * Take the drivable jobs that failed `maxAttempts` times in a row off the drive path until
   * `holdUntil`, returning them. The row stays until {@link complete} confirms the job was settled
   * as abandoned, so an abandonment that fails is offered again once the hold lapses.
   */
  holdExhausted(now: number, maxAttempts: number, holdUntil: number): ClaimedGuidedReviewJob[] {
    const rows = queryAll<QueueRow>(
      this.db,
      `SELECT job_key, workspace_id, job, attempts FROM guided_review_queue
         WHERE (state = 'queued' OR (state = 'active' AND lease_until <= ?)) AND attempts >= ?`,
      now,
      maxAttempts,
    )
    for (const row of rows) {
      this.db
        .prepare(
          `UPDATE guided_review_queue SET state = 'active', lease_until = ? WHERE job_key = ?`,
        )
        .run(holdUntil, row.job_key)
    }
    return rows.map(toClaimed)
  }

  size(state?: 'queued' | 'active'): number {
    const row = state
      ? queryOne<{ n: number }>(
          this.db,
          'SELECT COUNT(*) AS n FROM guided_review_queue WHERE state = ?',
          state,
        )
      : queryOne<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM guided_review_queue')
    return row?.n ?? 0
  }

  close(): void {
    this.db.close()
  }
}

/** Open the queue at `path` (a file under the developer's config dir, or `:memory:` in tests). */
export function createGuidedReviewQueue(path: string): SqliteGuidedReviewQueue {
  return new SqliteGuidedReviewQueue(openSqliteDb(path, SCHEMA))
}
