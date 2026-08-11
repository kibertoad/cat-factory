import { createRecordingLogger } from '@cat-factory/kernel'
import type { AgentRunRepository, StaleAgentRun } from '@cat-factory/kernel'
import { sweepPassRecoveredNothing } from '@cat-factory/server'
import { describe, expect, it } from 'vitest'
import { sweepStuckRuns } from '../src/infrastructure/workflows/sweeper'

// One stale run whose recovery throws must not take the pass down with it.
//
// The pass is what keeps every OTHER stale run recoverable, and `listStale` is ordered oldest
// first, so a run that can never be recovered (the worked example: a row that cannot be decoded,
// which every settle path re-reads on its way in) sorts to the FRONT of every future sweep. A
// propagating throw there is not one lost run, it is a sweeper that reports itself as running
// while recovering nothing, indefinitely.
//
// Isolation opens two holes of its own, and both are asserted here because both are silent. A pass
// in which EVERY run threw now RESOLVES, so the health report has to read the tally rather than the
// promise. And the prune loop at the end of the pass now always runs, so a run whose probe threw
// before it could be observed would lose its orphan clock every pass and never reach the hard-stall
// backstop: skipped forever instead of eventually settled.

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
    // Counted against what the pass took on, so a caller can tell one skipped run out of fifty
    // (a working sweeper) from a pass that recovered nothing at all.
    expect(result.attempted).toBe(3)
    expect(sweepPassRecoveredNothing(result)).toBe(false)
    expect(logger.lines.some((l) => l.level === 'error' && l.fields?.runId === poison)).toBe(true)
  })

  it('reports a pass in which every run threw as having recovered nothing', async () => {
    // The pass RESOLVES now, so `recordSuccess` would fire and reset the `sweep_degraded` streak on
    // exactly the wedged sweeper the streak exists to catch. This is the shape the health report
    // has to recognise from the tally alone.
    const result = await sweepStuckRuns({
      agentRunRepository: repositoryOf([staleRun('run_1'), staleRun('run_2')]),
      instanceState: async () => {
        throw new Error('workflows API is refusing every lookup')
      },
      redrive: async () => {},
      finalizeOrphan: async () => {},
      failStalled: async () => {},
      clock,
      leaseMs: 0,
      hardStallMs: 60 * 60 * 1000,
    })

    expect(result.failed).toBe(2)
    expect(result.attempted).toBe(2)
    expect(result.redriven).toBe(0)
    expect(sweepPassRecoveredNothing(result)).toBe(true)
  })

  it('carries a throwing run’s orphan clock forward so the hard-stall backstop can still fire', async () => {
    // The clock is per process and the prune loop drops anything not vouched for this pass. A probe
    // that throws vouches for nothing, so without an explicit carry-forward the deadline restarts
    // every pass and a permanently unprobeable run is skipped forever rather than settled.
    const orphanedSince = new Map<string, number>()
    const hardStallMs = 60 * 60 * 1000
    const firstSeen = clock.now() - hardStallMs - 1
    orphanedSince.set('run_1', firstSeen)
    const stalled: string[] = []

    // Pass 1: the probe throws, so nothing is learned about the run.
    await sweepStuckRuns({
      agentRunRepository: repositoryOf([staleRun('run_1')]),
      instanceState: async () => {
        throw new Error('lookup failed')
      },
      redrive: async () => {},
      finalizeOrphan: async () => {},
      failStalled: async (ref) => {
        stalled.push(ref.id)
      },
      clock,
      leaseMs: 0,
      hardStallMs,
      orphanedSince,
    })

    expect(orphanedSince.get('run_1')).toBe(firstSeen)

    // Pass 2: the probe answers, and the deadline it is measured against is the ORIGINAL one.
    await sweepStuckRuns({
      agentRunRepository: repositoryOf([staleRun('run_1')]),
      instanceState: async () => ({ state: 'missing' }),
      redrive: async () => {},
      finalizeOrphan: async () => {},
      failStalled: async (ref) => {
        stalled.push(ref.id)
      },
      clock,
      leaseMs: 0,
      hardStallMs,
      orphanedSince,
    })

    expect(stalled).toEqual(['run_1'])
  })
})
