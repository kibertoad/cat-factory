import type { AgentRunRef, StaleAgentRun } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { JobInsert, PgBoss } from 'pg-boss'
import { describe, expect, it, vi } from 'vitest'
import { type AdvanceQueueOptions, startStaleRunSweeper } from '../src/execution/pgBossRunner.js'
import type { JobStore } from '../src/execution/reclaim.js'

// Unit coverage for the sweeper's batch-queuing change (pg-boss initiative items B1 + B2):
// every `execution.advance` re-drive a single tick decides on — stale re-drives AND
// spend-paused resumes — is enqueued via ONE `boss.insert([...])` instead of a `send`
// per run, carrying the identical singletonKey/retry/expiry options.

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

const QUEUE = 'execution.advance'

const queueOptions: AdvanceQueueOptions = {
  expireInSeconds: 900,
  heartbeatSeconds: 60,
  retryLimit: 3,
  retryDelaySeconds: 5,
}

const cfg = { intervalMs: 60_000, leaseMs: 30_000, hardStallMs: 600_000 }

/** A fake pg-boss capturing `insert` batches and `send`s; every classify is "missing". */
function fakeBoss() {
  const inserts: { name: string; jobs: JobInsert[] }[] = []
  const sends: { name: string; data: unknown }[] = []
  const boss = {
    send: async (name: string, data: unknown) => {
      sends.push({ name, data })
      return 'job-id'
    },
    insert: async (name: string, jobs: JobInsert[]) => {
      inserts.push({ name, jobs })
      return jobs.map((_, i) => `job-${i}`)
    },
    deleteJob: async () => {},
  } as unknown as PgBoss
  // No advance job exists for any run → classifyAdvanceJob returns `missing`, so every stale
  // run is a clean re-drive candidate.
  const jobs: JobStore = { query: async () => ({ rows: [] }) }
  return { boss, jobs, inserts, sends }
}

/** A container whose stale/paused reads and spend gate are scripted per test. */
function fakeContainer(opts: {
  stale?: StaleAgentRun[]
  paused?: AgentRunRef[]
  overBudget?: (workspaceId: string) => boolean
}): ServerContainer {
  return {
    agentRunRepository: {
      listStale: async () => opts.stale ?? [],
      listPausedExecutions: async () => opts.paused ?? [],
    },
    workspaceService: { accountOf: async () => 'acct-1' },
    spendService: { isOverBudget: async (ws: string) => opts.overBudget?.(ws) ?? false },
    executionService: { failRun: async () => {} },
  } as unknown as ServerContainer
}

/** Run one immediate sweep tick and stop the interval. */
async function runOneTick(
  boss: PgBoss,
  jobs: JobStore,
  container: ServerContainer,
  seen: () => boolean,
): Promise<void> {
  const stop = startStaleRunSweeper(boss, jobs, container, cfg, queueOptions, noopLog)
  await vi.waitFor(() => expect(seen()).toBe(true))
  stop()
}

const staleRun = (id: string): StaleAgentRun => ({
  id,
  workspaceId: `ws_${id}`,
  kind: 'execution',
  updatedAt: Date.now() - 60_000,
})

describe('stale-run sweeper batches execution.advance re-drives', () => {
  it('re-drives multiple stale execution runs with ONE insert, not N sends', async () => {
    const { boss, jobs, inserts, sends } = fakeBoss()
    const container = fakeContainer({ stale: [staleRun('a'), staleRun('b'), staleRun('c')] })

    await runOneTick(boss, jobs, container, () => inserts.length > 0)

    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.name).toBe(QUEUE)
    expect(inserts[0]!.jobs.map((j) => j.singletonKey)).toEqual(['a', 'b', 'c'])
    expect(inserts[0]!.jobs.map((j) => j.data)).toEqual([
      { workspaceId: 'ws_a', executionId: 'a' },
      { workspaceId: 'ws_b', executionId: 'b' },
      { workspaceId: 'ws_c', executionId: 'c' },
    ])
    // Each row carries the same options a single `send` would.
    expect(inserts[0]!.jobs[0]).toMatchObject({
      singletonKey: 'a',
      expireInSeconds: 900,
      heartbeatSeconds: 60,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
    })
    // Execution re-drives no longer round-trip one `send` per run.
    expect(sends).toHaveLength(0)
  })

  it('folds stale re-drives and under-budget spend-paused resumes into the same batch', async () => {
    const { boss, jobs, inserts } = fakeBoss()
    const container = fakeContainer({
      stale: [staleRun('s1')],
      paused: [
        { id: 'p1', workspaceId: 'ws_p1', kind: 'execution' },
        { id: 'p2', workspaceId: 'ws_p2', kind: 'execution' },
      ],
    })

    await runOneTick(boss, jobs, container, () => inserts.length > 0)

    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.jobs.map((j) => j.singletonKey)).toEqual(['s1', 'p1', 'p2'])
  })

  it('excludes still-over-budget paused runs from the batch', async () => {
    const { boss, jobs, inserts } = fakeBoss()
    const container = fakeContainer({
      paused: [
        { id: 'poor', workspaceId: 'ws_poor', kind: 'execution' },
        { id: 'rich', workspaceId: 'ws_rich', kind: 'execution' },
      ],
      overBudget: (ws) => ws === 'ws_poor',
    })

    await runOneTick(boss, jobs, container, () => inserts.length > 0)

    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.jobs.map((j) => j.singletonKey)).toEqual(['rich'])
  })

  it('issues no insert when there is nothing to re-drive', async () => {
    const { boss, jobs, inserts, sends } = fakeBoss()
    const container = fakeContainer({})

    // No re-drives to observe, so let the immediate tick settle then assert it stayed empty.
    const stop = startStaleRunSweeper(boss, jobs, container, cfg, queueOptions, noopLog)
    await new Promise((resolve) => setTimeout(resolve, 30))
    stop()

    expect(inserts).toHaveLength(0)
    expect(sends).toHaveLength(0)
  })
})
