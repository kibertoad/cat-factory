import { noopOperationalMetrics } from '@cat-factory/kernel'
import { createSweepHealthTracker } from '@cat-factory/server'
import type { StaleAgentRun } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { JobInsert, PgBoss } from 'pg-boss'
import { describe, expect, it, vi } from 'vitest'
import { type AdvanceQueueOptions, startStaleRunSweeper } from '../src/execution/pgBossRunner.js'
import type { JobStore } from '../src/execution/reclaim.js'

// One stale run whose recovery throws must not end the tick.
//
// Recovering a run reads the queue, may reclaim a job and (past the hard-stall deadline) settles
// the run through the execution service, so any single run can throw on its own account. The
// stale list is ordered OLDEST FIRST, which is what makes an unrecoverable run so expensive: it
// sorts to the front of every future pass. Before this, such a run did not merely fail to recover,
// it ended the pass, so every stale run behind it went unrecovered, the spend-paused resumes never
// ran, and the batch enqueue never happened, tick after tick, while the sweeper logged one line
// and reported itself as alive.
//
// The hole isolation opens is asserted here too: a tick in which EVERY run threw now COMPLETES, so
// the pass would record a success and reset the `sweep_degraded` streak on precisely the wedged
// sweeper the streak watches for.

const queueOptions: AdvanceQueueOptions = {
  expireInSeconds: 900,
  heartbeatSeconds: 60,
  retryLimit: 3,
  retryDelaySeconds: 5,
}

const cfg = { intervalMs: 60_000, leaseMs: 30_000, hardStallMs: 600_000 }

const staleRun = (id: string): StaleAgentRun => ({
  id,
  workspaceId: `ws_${id}`,
  kind: 'execution',
  updatedAt: Date.now() - 60_000,
  redriveCount: 0,
})

/** A recording logger with the shape the sweeper's observability bag wants. */
function recordingLog() {
  const errors: { msg: string; fields?: Record<string, unknown> }[] = []
  const log = {
    info: () => {},
    warn: () => {},
    error: (msg: string, fields?: Record<string, unknown>) => errors.push({ msg, fields }),
  } as unknown as Logger
  return { log, errors }
}

describe('stale-run sweeper isolates one run’s failure from the pass', () => {
  it('re-drives the runs behind a throwing one and names the run it skipped', async () => {
    const inserts: { name: string; jobs: JobInsert[] }[] = []
    const boss = {
      send: async () => 'job-id',
      insert: async (name: string, jobs: JobInsert[]) => {
        inserts.push({ name, jobs })
        return jobs.map((_, i) => `job-${i}`)
      },
      deleteJob: async () => {},
    } as unknown as PgBoss
    // The classify read fails for ONE run (its `singleton_key` bind) and answers "no advance job"
    // for the rest. Stands in for any per-run fault: what is under test is that the pass survives
    // it, not which of the recovery steps produced it.
    const jobs: JobStore = {
      query: async (_text, values) => {
        if (values?.[1] === 'poison') throw new Error('Execution row has no block_id')
        return { rows: [] }
      },
    }
    const container = {
      agentRunRepository: {
        listStale: async () => [staleRun('poison'), staleRun('b'), staleRun('c')],
        listPausedExecutions: async () => [],
        recordRedrive: async () => 1,
      },
      workspaceService: { accountOf: async () => 'acct-1' },
      spendService: { isOverBudget: async () => false },
      executionService: { failRun: async () => {} },
    } as unknown as ServerContainer
    const { log, errors } = recordingLog()
    const health = createSweepHealthTracker()

    const stop = startStaleRunSweeper(boss, jobs, container, cfg, queueOptions, {
      log,
      metrics: noopOperationalMetrics,
      health,
    })
    await vi.waitFor(() => expect(inserts.length).toBe(1))
    stop()

    // The two runs sorted BEHIND the unrecoverable one still got their re-drive.
    expect(inserts[0]!.jobs.map((j) => j.singletonKey)).toEqual(['b', 'c'])
    // And the one that was skipped is named, per run: the pass-level `stale-run sweep failed`
    // line it used to produce said only that something in the tick threw.
    expect(errors.map((e) => e.fields?.runId)).toEqual(['poison'])
    // A pass that recovered two of three runs IS a working sweeper: the skipped run rides its own
    // counter, and streaking the pass on it would fire `sweep_degraded` on a healthy fleet.
    expect(health.worst()).toBeUndefined()
  })

  it('records a FAILED pass when every run it took on threw', async () => {
    const boss = {
      send: async () => 'job-id',
      insert: async () => [],
      deleteJob: async () => {},
    } as unknown as PgBoss
    // Every classify read fails: a permission change on `pgboss.job`, or a list of nothing but
    // poison rows. The tick completes (each run is isolated), and that is the trap.
    const jobs: JobStore = {
      query: async () => {
        throw new Error('permission denied for table job')
      },
    }
    const container = {
      agentRunRepository: {
        listStale: async () => [staleRun('a'), staleRun('b')],
        listPausedExecutions: async () => [],
        recordRedrive: async () => 1,
      },
      workspaceService: { accountOf: async () => 'acct-1' },
      spendService: { isOverBudget: async () => false },
      executionService: { failRun: async () => {} },
    } as unknown as ServerContainer
    const { log, errors } = recordingLog()
    const health = createSweepHealthTracker()

    const stop = startStaleRunSweeper(boss, jobs, container, cfg, queueOptions, {
      log,
      metrics: noopOperationalMetrics,
      health,
    })
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(3))
    stop()

    // Two per-run lines plus the pass-level one, and a streak the `sweep_degraded` condition reads.
    expect(errors.filter((e) => e.fields?.runId).length).toBe(2)
    expect(health.worst()).toMatchObject({ sweep: 'stale-run' })
  })
})
