import { DataIntegrityError } from '@cat-factory/kernel'
import type { AgentFailure, ExecutionRepository } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { RunStateMachine } from './RunStateMachine.js'

// A run whose stored row cannot be decoded must still be able to reach a terminal state.
//
// Every richer settle path begins by READING the run, so a row that violates its own contract
// (the case that produced this: `agent_runs.block_id` null on a `kind='execution'` row) used to
// be immortal — the stale-run sweeper kept re-listing it (`running` forever), each re-drive threw
// on the load, and the hard-stall backstop whose entire job is to settle such a run threw on its
// own first line. `markFailed` is pure SQL on both facades, so it is the one write that lands
// here; what it buys is that the run leaves `running` and the loop stops.

const UNREADABLE = new DataIntegrityError('Execution row has no block_id', {
  table: 'agent_runs',
  id: 'exec_1',
})

function makeMachine(getFails: unknown) {
  const failures: AgentFailure[] = []
  const executionRepository: ExecutionRepository = {
    get: async () => {
      throw getFails
    },
    markFailed: async (_ws: string, _id: string, failure: AgentFailure) => {
      failures.push(failure)
    },
  } as unknown as ExecutionRepository
  const logger = createRecordingLogger()
  const machine = new RunStateMachine({
    executionRepository,
    blockRepository: {} as never,
    events: {} as never,
    workRunner: {} as never,
    agentExecutor: {} as never,
    idGenerator: {} as never,
    clock: { now: () => 1_700_000_000_000 } as never,
    stepGraph: {} as never,
    logger,
  })
  return { machine, failures, logger }
}

describe('RunStateMachine: a run whose row cannot be read is disposed of, not re-driven', () => {
  it('fails the run terminally through the SQL-only write when the load throws', async () => {
    const { machine, failures, logger } = makeMachine(UNREADABLE)

    // The caller is the hard-stall backstop, whose own load is the throw under test.
    await machine.failRun('ws_1', 'exec_1', 'Run stalled.', 'stalled')

    expect(failures).toHaveLength(1)
    expect(failures[0]?.kind).toBe('state_unreadable')
    // The cause travels onto the row, so the operator reading the failure has the offending
    // column rather than a generic sentence.
    expect(failures[0]?.detail).toContain('block_id')
    expect(failures[0]?.hint).toBeTruthy()
    // `stepIndex` is deliberately absent: the cursor lives in the row that could not be read.
    expect(failures[0]?.stepIndex).toBeUndefined()
    expect(logger.lines.some((l) => l.level === 'error')).toBe(true)
  })

  it('propagates any OTHER load failure instead of failing the run', async () => {
    // The distinction is the whole reason the disposal is typed rather than a bare catch: a
    // database blip must leave a live run alone to be recovered on the next pass.
    const { machine, failures } = makeMachine(new Error('connection terminated unexpectedly'))

    await expect(machine.failRun('ws_1', 'exec_1', 'Run stalled.', 'stalled')).rejects.toThrow(
      /connection terminated/,
    )
    expect(failures).toHaveLength(0)
  })
})
