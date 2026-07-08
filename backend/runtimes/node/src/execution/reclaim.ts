import type { PgBoss } from 'pg-boss'

/**
 * Minimal read seam over the pg-boss job table. The pg `Pool` satisfies it structurally,
 * so the sweeper can classify a run's advance job without importing `pg` directly or
 * widening the runner's constructor surface.
 */
export interface JobStore {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

type AdvanceJobState = 'live' | 'orphaned' | 'missing'

export interface AdvanceJobStatus {
  state: AdvanceJobState
  jobId: string | null
}

/**
 * Classify a run's live advance job so the stale-run sweeper can recover an orphan without
 * double-driving a healthy run.
 *
 * The `exclusive` queue policy makes a bare re-`send` an `ON CONFLICT DO NOTHING` no-op while
 * ANY advance job for the run is `created`/`active`/`retry`. That is the whole point for a
 * run that is genuinely being driven — but it also means the sweeper cannot tell (and so
 * cannot recover) an ORPHANED run, whose worker crashed leaving the job stuck `active` with a
 * frozen heartbeat, from a HEALTHY long drive that is merely sleeping between container polls
 * (and still heartbeating its active job). Both look identical to `listStale`, which keys off
 * `agent_runs.updated_at` — and a sleeping drive does not write that between polls.
 *
 * This reads pg-boss's own `heartbeat_on` — the same signal pg-boss maintenance uses to
 * reclaim crashed workers — to disambiguate:
 *
 * - `live`     — an `active` job with a fresh heartbeat (a real drive), or a `created`/`retry`
 *                job about to be picked up. Leave it; a re-send would no-op anyway.
 * - `orphaned` — an `active` job whose heartbeat is older than `staleHeartbeatMs`: the worker
 *                is gone but its singletonKey is still held, so a re-send no-ops. The caller
 *                must {@link reclaimAdvanceJob} to free the key before re-driving.
 * - `missing`  — no created/active/retry job at all: a re-send re-drives cleanly.
 *
 * Reaching into pg-boss's schema is acceptable here (this project is pre-1.0, and the runner
 * already depends on the `exclusive`/`singletonKey`/`heartbeatSeconds` internals). The default
 * pg-boss schema is `pgboss`.
 */
export async function classifyAdvanceJob(
  jobs: JobStore,
  queue: string,
  singletonKey: string,
  staleHeartbeatMs: number,
  now: number,
): Promise<AdvanceJobStatus> {
  const { rows } = await jobs.query(
    `SELECT id, state, (extract(epoch from heartbeat_on) * 1000)::bigint AS heartbeat_ms
       FROM pgboss.job
      WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'active', 'retry')
      ORDER BY created_on DESC
      LIMIT 1`,
    [queue, singletonKey],
  )
  const row = rows[0]
  if (!row) return { state: 'missing', jobId: null }
  const jobId = String(row.id)
  // `created`/`retry` jobs are queued and will be (re)driven by a worker without our help.
  if (row.state !== 'active') return { state: 'live', jobId }
  const heartbeatMs = row.heartbeat_ms == null ? null : Number(row.heartbeat_ms)
  const fresh = heartbeatMs != null && now - heartbeatMs < staleHeartbeatMs
  return { state: fresh ? 'live' : 'orphaned', jobId }
}

/** Free an orphaned advance job's singletonKey so a fresh advance can be enqueued. */
export async function reclaimAdvanceJob(boss: PgBoss, queue: string, jobId: string): Promise<void> {
  await boss.deleteJob(queue, jobId)
}
