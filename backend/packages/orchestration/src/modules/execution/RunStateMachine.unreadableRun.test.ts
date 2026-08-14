import { DataIntegrityError } from '@cat-factory/kernel'
import type {
  AgentFailure,
  Block,
  BlockPatch,
  BlockRepository,
  BoardChange,
  ExecutionRepository,
} from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { RunStateMachine } from './RunStateMachine.js'

// A run whose stored row cannot be decoded must still be able to reach a terminal state.
//
// Every richer settle path begins by READING the run, so a row that violates its own contract
// (the case that produced this: `agent_runs.block_id` null on a `kind='execution'` row) used to be
// immortal: the stale-run sweeper kept re-listing it (`running` forever), each re-drive threw on
// the load, and the hard-stall backstop whose entire job is to settle such a run threw on its own
// first line. `markFailed` is pure SQL on both facades, so it is the one write that lands here;
// what it buys is that the run leaves `running` and the loop stops.
//
// Two things narrow it, and both are asserted below because getting either wrong is silent. The
// disposal fires only for a `malformed` row, never for a value this build merely does not
// RECOGNISE (during a rolling deploy that value is a healthy run written by the newer replica).
// And it projects onto the owning BLOCK, read off the reverse link, since a settled run row with a
// card still frozen `in_progress` leaves the human half of the incident unresolved forever.

const UNREADABLE = new DataIntegrityError(
  'Execution row has no block_id',
  { table: 'agent_runs', id: 'exec_1' },
  'malformed',
)

const UNRECOGNIZED = new DataIntegrityError(
  "Invalid stored value 'quiesced' for status",
  { table: 'agent_runs', column: 'status', id: 'exec_1' },
  'unrecognized_value',
)

const TASK: Block = {
  id: 'blk_1',
  title: 'Add a healthcheck',
  type: 'task',
  description: '',
  position: { x: 0, y: 0 },
  status: 'in_progress',
  progress: 0.5,
  dependsOn: [],
  executionId: 'exec_1',
  level: 'task',
  parentId: null,
} as unknown as Block

/** `block` is what the reverse link resolves to: a block, nothing, or a read that throws. */
function makeMachine(getFails: unknown, block: Block | null | 'throws' = TASK) {
  const failures: AgentFailure[] = []
  const patches: Array<{ id: string; patch: BlockPatch }> = []
  const boardEvents: BoardChange[] = []
  const executionRepository: ExecutionRepository = {
    get: async () => {
      throw getFails
    },
    markFailed: async (_ws: string, _id: string, failure: AgentFailure) => {
      failures.push(failure)
    },
  } as unknown as ExecutionRepository
  const blockRepository: BlockRepository = {
    getByExecution: async () => {
      if (block === 'throws') throw new Error('blocks table unavailable')
      return block
    },
    update: async (_ws: string, id: string, patch: BlockPatch) => {
      patches.push({ id, patch })
    },
  } as unknown as BlockRepository
  const logger = createRecordingLogger()
  const machine = new RunStateMachine({
    executionRepository,
    blockRepository,
    events: {
      boardChanged: async (_ws: string, change: BoardChange) => {
        boardEvents.push(change)
      },
    } as never,
    workRunner: {} as never,
    agentExecutor: {} as never,
    idGenerator: {} as never,
    clock: { now: () => 1_700_000_000_000 } as never,
    stepGraph: {} as never,
    logger,
  })
  return { machine, failures, patches, boardEvents, logger }
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

  it('blocks the owning block, found through the reverse link, and pushes it', async () => {
    // The run names no block (that is WHY it cannot be decoded), but the block names the run.
    // Without this the card stays `in_progress` forever with no failure card and no Retry, since
    // the run row itself is dropped from the board snapshot.
    const { machine, patches, boardEvents } = makeMachine(UNREADABLE)

    await machine.failRun('ws_1', 'exec_1', 'Run stalled.', 'stalled')

    expect(patches).toEqual([{ id: 'blk_1', patch: { status: 'blocked' } }])
    // No fabricated progress: the step list lives in the row that could not be read.
    expect(patches[0]?.patch.progress).toBeUndefined()
    // Pushed as a BOARD change (there is no instance to emit) carrying the updated block, so a
    // connected client patches the card instead of re-reading the whole snapshot.
    expect(boardEvents).toHaveLength(1)
    expect(boardEvents[0]?.block?.status).toBe('blocked')
  })

  it('still disposes of the run when no block carries it', async () => {
    // A `cancel` clears the reverse link, so the projection can legitimately find nothing. That
    // must not cost the disposal: the run row leaving `running` is the part that stops the loop.
    const { machine, failures, patches, logger } = makeMachine(UNREADABLE, null)

    await machine.failRun('ws_1', 'exec_1', 'Run stalled.', 'stalled')

    expect(failures).toHaveLength(1)
    expect(patches).toHaveLength(0)
    expect(logger.lines.some((l) => l.msg.includes('no block carries'))).toBe(true)
  })

  it('settles the row even when the projection read itself fails', async () => {
    // The projection is best-effort in the strict sense: a board read that throws must not
    // propagate out of the disposal and resurrect the immortal run it just settled. Ordered after
    // the run write for exactly this reason.
    const { machine, failures, patches } = makeMachine(UNREADABLE, 'throws')

    await machine.failRun('ws_1', 'exec_1', 'Run stalled.', 'stalled')

    expect(failures).toHaveLength(1)
    expect(failures[0]?.kind).toBe('state_unreadable')
    expect(patches).toHaveLength(0)
  })

  it('propagates a value this build does not RECOGNISE instead of failing the run', async () => {
    // The rolling-deploy case, and the reason disposal is gated on the fault rather than on "the
    // row did not decode". An `ExecutionStatus` member a newer replica writes reads exactly like
    // corruption from an older one; disposing would destroy a live, healthy run irreversibly,
    // where propagating costs a re-drive that the newer replica satisfies.
    const { machine, failures, patches } = makeMachine(UNRECOGNIZED)

    await expect(machine.failRun('ws_1', 'exec_1', 'Run stalled.', 'stalled')).rejects.toThrow(
      /quiesced/,
    )
    expect(failures).toHaveLength(0)
    expect(patches).toHaveLength(0)
  })

  it('propagates an integrity error whose fault was lost in transit', async () => {
    // A `DataIntegrityError` reconstructed across a boundary that dropped the fault (the
    // mothership persistence RPC's older peer) knows less than the thrower did, so it takes the
    // reversible disposition rather than the destructive one.
    const faultless = new Error('Execution row has no block_id')
    faultless.name = 'DataIntegrityError'
    const { machine, failures } = makeMachine(faultless)

    await expect(machine.failRun('ws_1', 'exec_1', 'Run stalled.', 'stalled')).rejects.toThrow(
      /block_id/,
    )
    expect(failures).toHaveLength(0)
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
