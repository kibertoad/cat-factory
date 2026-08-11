import { createRecordingLogger } from '@cat-factory/kernel'
import type { AgentRunRepository, StaleAgentRun } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { sweepStuckRuns } from '../src/infrastructure/workflows/sweeper'

// One stale run whose recovery throws must not take the pass down with it.
//
// The pass is what keeps every OTHER stale run recoverable, and `listStale` is ordered oldest
// first — so a run that can never be recovered (the worked example: a row that cannot be decoded,
// which every settle path re-reads on its way in) sorts to the FRONT of every future sweep. A
// propagating throw there is not one lost run, it is a sweeper that reports itself as running
// while recovering nothing, indefinitely.

const clock = { now: () => 1_000_000 }

function staleRun(id: string, overrides: Partial<StaleAgentRun> = {}): StaleAgentRun {
  return {
    workspaceId: 'ws_1',
    id,
    kind: 'execution',
    updatedAt: 0,
    redriveCount: 0,
    ...overrides,
  }
}

/** A repository that reports exactly `stale`; nothing else on the port is reached. */
function repositoryOf(stale: StaleAgentRun[]): AgentRunRepository {
  return {
    listStale: async () => stale,
    recordRedrive: async () => 1,
    getRef: async () => null,
    listPausedExecutions: async () => [],
    liveRunIds: async () => [],
  }
}

describe('sweepStuckRuns: one unrecoverable run does not end the pass', () => {
  it('recovers the runs behind a throwing one, and reports the one it skipped', async () => {
    const logger = createRecordingLogger()
    const redrove: string[] = []
    const poison = 'run_poison'

    const result = await sweepStuckRuns({
      agentRunRepository: repositoryOf([staleRun(poison), staleRun('run_2'), staleRun('run_3')]),
      instanceState: async () => ({ state: 'missing' }),
      redrive: async (ref) => {
        // Stands in for any per-run failure: the run that cannot be recovered is FIRST, exactly
        // as the oldest-first ordering guarantees it will be on every subsequent pass too.
        if (ref.id === poison) throw new Error('Execution row has no block_id')
        redrove.push(ref.id)
      },
      finalizeOrphan: async () => {},
      failStalled: async () => {},
      clock,
      leaseMs: 0,
      // Large deadline: this case is about isolation, not the hard-stall backstop.
      hardStallMs: 60 * 60 * 1000,
      logger,
    })

    expect(redrove).toEqual(['run_2', 'run_3'])
    expect(result.redriven).toBe(2)
    // The skipped run is REPORTED rather than absorbed: it is the only evidence that a run is
    // permanently unrecoverable, and the pass now looks entirely healthy without it.
    expect(result.failed).toBe(1)
    expect(logger.lines.some((l) => l.level === 'error' && l.fields?.runId === poison)).toBe(true)
  })
})
