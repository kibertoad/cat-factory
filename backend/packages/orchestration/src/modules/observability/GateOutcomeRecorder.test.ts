import { describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import type { ExecutionInstance, GateOutcomeRecord, PipelineStep } from '@cat-factory/kernel'
import { GateOutcomeRecorder } from './GateOutcomeRecorder.js'

// The WRITE half of the gate/CI-fixer attempt statistics: what the engine's gate machine
// projects when a polling gate reaches a terminal verdict.

function instance(over: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return { id: 'exec-1', blockId: 'blk-1', ...over } as ExecutionInstance
}

function step(over: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'ci',
    gate: { phase: 'checking', attempts: 2, maxAttempts: 3, watchSince: 1_000 },
    ...over,
  } as PipelineStep
}

function recorderWith(record: (row: GateOutcomeRecord) => Promise<void>, now = 5_000) {
  const rows: GateOutcomeRecord[] = []
  const logger = createRecordingLogger()
  const recorder = new GateOutcomeRecorder({
    gateOutcomeRepository: {
      record: async (row) => {
        rows.push(row)
        return record(row)
      },
      statsSince: async () => [],
      deleteOlderThan: async () => 0,
    },
    now: () => now,
    logger,
  })
  return { recorder, rows, logger }
}

const ok = async () => {}

describe('GateOutcomeRecorder', () => {
  it('derives a replay-stable id from the run, the step index and the outcome', async () => {
    // A minted id would let one settle become two rows under a driver replay and inflate every
    // statistic the projection exists to report.
    const { recorder, rows } = recorderWith(ok)
    await recorder.record({
      workspaceId: 'ws-1',
      instance: instance(),
      step: step(),
      stepIndex: 4,
      helperKind: 'ci-fixer',
      outcome: 'passed',
    })
    expect(rows[0]?.id).toBe('exec-1:4:passed')
  })

  it('gives a differently-ending re-run its own row rather than collapsing onto the first', async () => {
    // The outcome is part of the id precisely so a step that is re-run and ends the OTHER way
    // records that second, genuinely different verdict.
    const { recorder, rows } = recorderWith(ok)
    const common = {
      workspaceId: 'ws-1',
      instance: instance(),
      step: step(),
      stepIndex: 4,
      helperKind: 'ci-fixer',
    } as const
    await recorder.record({ ...common, outcome: 'exhausted' })
    await recorder.record({ ...common, outcome: 'passed' })
    expect(rows.map((r) => r.id)).toEqual(['exec-1:4:exhausted', 'exec-1:4:passed'])
  })

  it('counts only the helper attempts whose own job failed', async () => {
    // A fixer that keeps crashing and one that runs clean but cannot get the build green have
    // the same attempt count and need opposite fixes.
    const { recorder, rows } = recorderWith(ok)
    await recorder.record({
      workspaceId: 'ws-1',
      instance: instance(),
      step: step({
        gate: {
          phase: 'checking',
          attempts: 3,
          maxAttempts: 3,
          watchSince: 1_000,
          attemptLog: [
            { attempt: 1, at: 1, outcome: 'failed' },
            { attempt: 2, at: 2, outcome: 'completed' },
            { attempt: 3, at: 3, outcome: 'failed' },
          ],
        },
      }),
      stepIndex: 0,
      helperKind: 'ci-fixer',
      outcome: 'exhausted',
    })
    expect(rows[0]?.attempts).toBe(3)
    expect(rows[0]?.helperFailures).toBe(2)
    expect(rows[0]?.durationMs).toBe(4_000)
  })

  it('reports a null duration rather than a zero when the gate has no start stamp', async () => {
    // A duration of zero would read as an instant gate, which is a different claim from "we
    // do not know when this one started".
    const { recorder, rows } = recorderWith(ok)
    await recorder.record({
      workspaceId: 'ws-1',
      instance: instance(),
      step: step({ gate: { phase: 'checking', attempts: 0, maxAttempts: 3 } }),
      stepIndex: 0,
      helperKind: 'ci-fixer',
      outcome: 'passed',
    })
    expect(rows[0]?.durationMs).toBeNull()
  })

  it('swallows a store failure but names it, so a broken sink is not silent', async () => {
    // Observability about a run must never fail the run it describes, and a silently broken
    // sink looks exactly like a deployment whose gates never escalate.
    const { recorder, logger } = recorderWith(async () => {
      throw new Error('store down')
    })
    await expect(
      recorder.record({
        workspaceId: 'ws-1',
        instance: instance(),
        step: step(),
        stepIndex: 0,
        helperKind: 'ci-fixer',
        outcome: 'passed',
      }),
    ).resolves.toBeUndefined()
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  })

  it('records nothing for a step that never entered its gate', async () => {
    const { recorder, rows } = recorderWith(ok)
    await recorder.record({
      workspaceId: 'ws-1',
      instance: instance(),
      step: step({ gate: undefined }),
      stepIndex: 0,
      helperKind: 'ci-fixer',
      outcome: 'passed',
    })
    expect(rows).toEqual([])
  })
})
