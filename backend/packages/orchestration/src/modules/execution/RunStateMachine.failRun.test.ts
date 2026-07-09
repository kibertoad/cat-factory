import type {
  AgentFailure,
  Block,
  BlockRepository,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { RunStateMachine } from './RunStateMachine.js'

// `failRun` records a terminal failure on the run AND projects it onto the block (→ `blocked`).
// Race-audit 2.3 closed the terminal clobber on the RUN row (`markFailed` is SQL-guarded against a
// `done`/`failed` row), but the BLOCK projection is the same clobber one layer out: a `stopRun`
// racing a run the merger just flipped `done` (in `failRun`'s load→`markFailed` window) reads a
// stale `running` snapshot, so `markFailed` correctly no-ops — yet the block-status write must NOT
// then flip the merged task's block to `blocked`. These tests pin that the block projection is
// gated on the AUTHORITATIVE post-write run status.

const BASE = {
  id: 'exec_1',
  blockId: 'task_1',
  pipelineId: 'pl',
  pipelineName: 'Pipeline',
  steps: [] as ExecutionInstance['steps'],
  currentStep: 0,
}

function makeMachine(opts: {
  /** The row as the merge/stop race left it by the time `markFailed`'s write lands. */
  storedStatus: 'running' | 'done'
}) {
  const blockUpdates: Array<{ status?: string }> = []
  const published: ExecutionInstance[] = []

  // The stored row the second (authoritative) read + the SQL-guarded `markFailed` see.
  const stored: ExecutionInstance = { ...BASE, status: opts.storedStatus }
  let firstGet = true
  const executionRepository: ExecutionRepository = {
    // `failRun` loads once up front (a snapshot that may already be stale) and re-reads the
    // authoritative row after `markFailed`. The first load returns a still-`running` snapshot so
    // the in-memory terminal guard is passed; the re-read returns the stored truth.
    get: async () =>
      firstGet ? ((firstGet = false), { ...BASE, status: 'running' }) : { ...stored },
    markFailed: async (_ws: string, _id: string, failure: AgentFailure) => {
      // Mirror the repo's SQL guard: a `done`/`failed` row is never overwritten.
      if (stored.status === 'done' || stored.status === 'failed') return
      stored.status = 'failed'
      stored.failure = failure
    },
  } as unknown as ExecutionRepository

  const blockRepository: BlockRepository = {
    get: async () => ({ id: BASE.blockId }) as unknown as Block,
    update: async (_ws: string, _id: string, patch: { status?: string }) => {
      blockUpdates.push(patch)
    },
  } as unknown as BlockRepository

  const events: ExecutionEventPublisher = {
    executionChanged: async (_ws: string, instance: ExecutionInstance) => {
      published.push(instance)
    },
  } as unknown as ExecutionEventPublisher

  const machine = new RunStateMachine({
    executionRepository,
    blockRepository,
    events,
    workRunner: {} as never,
    // Not an async executor → `stopRunContainer` no-ops (nothing to reclaim).
    agentExecutor: {} as never,
    idGenerator: {} as never,
    clock: { now: () => 1 } as never,
    stepGraph: {} as never,
  })
  return { machine, blockUpdates, published }
}

describe('RunStateMachine.failRun — terminal block-projection guard (race-audit 2.3)', () => {
  it('does NOT flip the block to `blocked` when a stop races a run that just merged (done)', async () => {
    const { machine, blockUpdates, published } = makeMachine({ storedStatus: 'done' })
    await machine.failRun('ws_1', 'exec_1', 'Stopped by the user.', 'cancelled')
    // `markFailed` no-ops on the `done` row, so the block must be left as the merge set it.
    expect(blockUpdates).toHaveLength(0)
    // The emit reflects the authoritative `done`, not a spurious failure.
    expect(published.at(-1)?.status).toBe('done')
  })

  it('flips the block to `blocked` for a genuine failure (no race)', async () => {
    const { machine, blockUpdates, published } = makeMachine({ storedStatus: 'running' })
    await machine.failRun('ws_1', 'exec_1', 'boom', 'agent')
    expect(blockUpdates).toEqual([{ status: 'blocked', progress: 0 }])
    expect(published.at(-1)?.status).toBe('failed')
  })
})
