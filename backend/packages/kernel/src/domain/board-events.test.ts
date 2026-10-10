import { describe, expect, it } from 'vitest'
import { blockLevelSchema } from '@cat-factory/contracts'
import type { Block, BlockLevel, BootstrapJob } from './types.js'
import {
  boardChangeSubject,
  boardWireEvent,
  bootstrapWireEvent,
  deliverableBoardBlock,
} from './board-events.js'

function block(over: Partial<Block> = {}): Block {
  return {
    id: 'blk_1',
    title: 'web',
    type: 'service',
    description: '',
    position: { x: 10, y: 20 },
    status: 'ready',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'task',
    parentId: 'frame_1',
    ...over,
  } as Block
}

describe('deliverableBoardBlock', () => {
  it('refuses to carry a service frame', () => {
    // The failure this prevents is silent: one payload is published for every board a shared
    // service is mounted on, so a frame carrying the origin's coordinates would land on the
    // others and jump the frame to a spot none of them shows it at. Exactly what
    // `applyMountLayout` exists to stop, arriving by a different door.
    expect(deliverableBoardBlock(block({ level: 'frame', parentId: null }))).toBeNull()
  })

  it('refuses to carry a headless internal anchor block', () => {
    // A public-API run's own "task": `composeBoard` filters it out of every snapshot, so pushing
    // it live would leave a top-level ghost card holding the external caller's brief that no
    // later read can remove. `RunStateMachine.emitInstance` refuses the same block on the
    // per-instance path; this is that refusal's board-event twin.
    expect(deliverableBoardBlock(block({ internal: true, parentId: null }))).toBeNull()
  })

  it('gives every level in the schema a definite answer, carrying the row-geometry ones', () => {
    // Derived from the picklist `BlockLevel` itself comes from rather than a hand-written list, so
    // a level added to the vocabulary is exercised here the moment it exists. The compile-time
    // half of the same guard is `GEOMETRY_IS_PER_BOARD` being a total `Record<BlockLevel, …>`.
    for (const level of blockLevelSchema.options) {
      const candidate = block({ level, parentId: level === 'frame' ? null : 'frame_1' })
      const carried = deliverableBoardBlock(candidate)
      if (level === 'frame') expect(carried, 'a frame is per-board').toBeNull()
      else expect(carried, `${level} geometry lives on the shared row`).toBe(candidate)
    }
  })

  it('withholds a block whose level it does not recognise', () => {
    // Fail SAFE: an unrecognised level costs a coarse refresh, which is always correct, where
    // guessing it deliverable misplaces the block on every board the fan-out reaches.
    expect(deliverableBoardBlock(block({ level: 'gantt' as BlockLevel }))).toBeNull()
  })

  it('answers null for an absent block', () => {
    expect(deliverableBoardBlock(null)).toBeNull()
    expect(deliverableBoardBlock(undefined)).toBeNull()
  })
})

describe('boardChangeSubject', () => {
  it('prefers the named block, falls back to the carried one, else names nothing', () => {
    expect(boardChangeSubject({ reason: 'r', blockId: 'blk_named' })).toBe('blk_named')
    expect(boardChangeSubject({ reason: 'r', block: block() })).toBe('blk_1')
    expect(boardChangeSubject({ reason: 'r' })).toBeNull()
  })
})

describe('boardWireEvent', () => {
  it('carries a deliverable block and keeps the fan-out subject off the wire', () => {
    const task = block()
    const event = boardWireEvent({ reason: 'block-added', blockId: task.id, block: task }, 7)

    expect(event).toEqual({ type: 'board', reason: 'block-added', block: task, at: 7 })
    // `blockId` is how the backend resolved WHICH workspaces to publish to; it is spent by now,
    // and a client that received it would have nothing to do with it but assume it mattered.
    expect(event).not.toHaveProperty('blockId')
  })

  it('degrades a withheld payload to the coarse signal rather than dropping the event', () => {
    const event = boardWireEvent(
      { reason: 'block-updated', block: block({ level: 'frame', parentId: null }) },
      7,
    )

    // The client still learns the board changed; it just re-reads its own projection.
    expect(event).toEqual({ type: 'board', reason: 'block-updated', block: null, at: 7 })
  })
})

describe('bootstrapWireEvent', () => {
  it('carries the job and withholds the run’s service frame', () => {
    const job = { id: 'bsj_1', status: 'running' } as BootstrapJob
    const frame = block({ level: 'frame', parentId: null })

    expect(bootstrapWireEvent(job, frame, 7)).toEqual({
      type: 'bootstrap',
      job,
      block: null,
      at: 7,
    })
  })
})
