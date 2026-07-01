import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type DrizzleDb, createDbClient } from '../src/db/client.js'
import { migrate } from '../src/db/migrate.js'
import { classifyAdvanceJob, reclaimAdvanceJob } from '../src/execution/reclaim.js'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'

// Real-Postgres coverage for the stale-run sweeper's new, Node-specific building blocks:
//   - `AgentRunRepository.liveRunIds` (batch terminal-state filter powering the local
//     orphaned-container reap), and
//   - `classifyAdvanceJob` / `reclaimAdvanceJob` — how the sweeper tells a healthy long
//     drive (heartbeating) from an orphaned one (dead worker) and frees the exclusive
//     singletonKey so the run can be re-driven. This is the fix for a run that was stuck
//     `running` forever because the bare re-`send` no-op'd onto the orphaned active job.

const QUEUE = 'execution.advance'
const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('node stale-run sweeper building blocks', () => {
  let db: DrizzleDb
  let pool: Pool
  let boss: PgBoss
  let repos: ReturnType<typeof createDrizzleRepositories>

  beforeAll(async () => {
    const client = createDbClient(databaseUrl!)
    db = client.db
    pool = client.pool
    await migrate(db, pool)
    boss = new PgBoss(databaseUrl!)
    await boss.start()
    await boss.createQueue(QUEUE, { policy: 'exclusive' })
    repos = createDrizzleRepositories(db, { now: () => Date.now() })
  }, 30_000)

  afterAll(async () => {
    await boss?.stop({ graceful: false })
    await pool?.end()
  })

  it('liveRunIds returns only non-terminal runs', async () => {
    const ws = `ws_${randomSuffix()}`
    const now = Date.now()
    const rows: Array<[string, string]> = [
      [`exec_live_${randomSuffix()}`, 'running'],
      [`exec_blocked_${randomSuffix()}`, 'blocked'],
      [`exec_paused_${randomSuffix()}`, 'paused'],
      [`exec_done_${randomSuffix()}`, 'done'],
      [`exec_failed_${randomSuffix()}`, 'failed'],
    ]
    for (const [id, status] of rows) {
      await pool.query(
        `INSERT INTO agent_runs (workspace_id, id, kind, status, detail, created_at, updated_at)
         VALUES ($1, $2, 'execution', $3, '{}', $4, $4)`,
        [ws, id, status, now],
      )
    }
    const live = await repos.agentRunRepository.liveRunIds(rows.map(([id]) => id))
    const liveSet = new Set(live)
    expect(liveSet.has(rows[0]![0])).toBe(true) // running
    expect(liveSet.has(rows[1]![0])).toBe(true) // blocked
    expect(liveSet.has(rows[2]![0])).toBe(true) // paused
    expect(liveSet.has(rows[3]![0])).toBe(false) // done
    expect(liveSet.has(rows[4]![0])).toBe(false) // failed
    // A run id with no row is not live either.
    expect(await repos.agentRunRepository.liveRunIds(['exec_missing'])).toEqual([])
  })

  it('classifies live / orphaned / missing advance jobs and reclaims the orphan', async () => {
    const runId = `exec_${randomSuffix()}`
    const staleHeartbeatMs = 60_000

    // No job yet → missing.
    expect((await classifyAdvanceJob(pool, QUEUE, runId, staleHeartbeatMs, Date.now())).state).toBe(
      'missing',
    )

    // Enqueue an advance job for the run (created state) → live (about to be picked up).
    const jobId = await boss.send(QUEUE, { runId }, { singletonKey: runId })
    expect(jobId).toBeTruthy()
    expect((await classifyAdvanceJob(pool, QUEUE, runId, staleHeartbeatMs, Date.now())).state).toBe(
      'live',
    )

    // Simulate a live worker holding it with a FRESH heartbeat → still live.
    await pool.query(`UPDATE pgboss.job SET state = 'active', heartbeat_on = now() WHERE id = $1`, [
      jobId,
    ])
    expect((await classifyAdvanceJob(pool, QUEUE, runId, staleHeartbeatMs, Date.now())).state).toBe(
      'live',
    )

    // Simulate a crashed worker: active job whose heartbeat froze long ago → orphaned.
    await pool.query(
      `UPDATE pgboss.job SET heartbeat_on = now() - interval '1 hour' WHERE id = $1`,
      [jobId],
    )
    const orphaned = await classifyAdvanceJob(pool, QUEUE, runId, staleHeartbeatMs, Date.now())
    expect(orphaned.state).toBe('orphaned')
    expect(orphaned.jobId).toBe(jobId)

    // Reclaiming frees the singletonKey → back to missing, so a fresh advance can enqueue.
    await reclaimAdvanceJob(boss, QUEUE, orphaned.jobId!)
    expect((await classifyAdvanceJob(pool, QUEUE, runId, staleHeartbeatMs, Date.now())).state).toBe(
      'missing',
    )
    // The exclusive singleton is free again — a re-send now succeeds instead of no-op'ing.
    const reId = await boss.send(QUEUE, { runId }, { singletonKey: runId })
    expect(reId).toBeTruthy()
  })
})

let counter = 0
function randomSuffix(): string {
  // Deterministic-enough unique id per test row without Math.random (kept stable across runs).
  counter += 1
  return `${Date.now().toString(36)}_${counter}`
}
