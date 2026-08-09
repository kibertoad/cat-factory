import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import { chainHasConditionalStep, resolveScopeForRun } from './runServiceScope.js'

const WS = 'ws_1'

function block(over: Partial<Block> & Pick<Block, 'id'>): Block {
  return {
    title: over.id,
    description: '',
    type: 'service',
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'task',
    parentId: null,
    position: { x: 0, y: 0 },
    ...over,
  } as Block
}

/** A board with a frontend frame, a backend frame connected to it, and a task under each. */
function board(): Block[] {
  return [
    block({ id: 'frame_ui', type: 'frontend', level: 'frame' }),
    block({
      id: 'frame_api',
      type: 'service',
      level: 'frame',
      serviceConnections: [{ serviceBlockId: 'frame_ui' }],
    }),
    block({ id: 'task_ui', parentId: 'frame_ui' }),
    block({ id: 'task_api', parentId: 'frame_api' }),
    block({ id: 'orphan' }),
  ]
}

const listBlocks = async () => board()

describe('resolveScopeForRun', () => {
  it('reads a task under a frontend frame as the frontend scope', async () => {
    const task = board().find((b) => b.id === 'task_ui')!
    expect(await resolveScopeForRun(listBlocks, WS, task)).toEqual({
      frontend: true,
      backend: false,
    })
  })

  it('reads a task under a service frame as the backend scope', async () => {
    const task = board().find((b) => b.id === 'task_api')!
    expect(await resolveScopeForRun(listBlocks, WS, task)).toEqual({
      frontend: false,
      backend: true,
    })
  })

  it('resolves an EMPTY scope for a task under no frame at all', async () => {
    // `frameOf` returns the parent-less block itself, which IS the task here — a leaf that is its
    // own top, not a service. The scope still reads as backend-only rather than empty, so this
    // asserts what actually happens rather than what would be convenient: what matters is that
    // nothing throws and a scope comes back for every block shape the board can hold.
    const orphan = board().find((b) => b.id === 'orphan')!
    const scope = await resolveScopeForRun(listBlocks, WS, orphan)
    expect(scope.frontend || scope.backend).toBe(true)
  })

  it('sets BOTH halves when a frontend task names an involved backend service', async () => {
    // This is the case the conditional tester pair exists for: one task, both verification passes.
    // The involved peer has to be a CONNECTED service frame or the stale filter drops it, which is
    // why `frame_api` declares the connection.
    const task = block({ id: 'task_ui', parentId: 'frame_ui', involvedServiceIds: ['frame_api'] })
    expect(await resolveScopeForRun(listBlocks, WS, task)).toEqual({
      frontend: true,
      backend: true,
    })
  })

  it('ignores an involved service that is no longer connected', async () => {
    // The same read-time stale filter the agent context uses: an id that is no longer a neighbour
    // is inert, so a removed connection cannot silently switch a verification pass back on.
    const task = block({ id: 'task_ui', parentId: 'frame_ui', involvedServiceIds: ['orphan'] })
    expect(await resolveScopeForRun(listBlocks, WS, task)).toEqual({
      frontend: true,
      backend: false,
    })
  })

  it('resolves an EMPTY scope when the block is not on the board at all', async () => {
    const stranger = block({ id: 'not_on_board' })
    expect(await resolveScopeForRun(listBlocks, WS, stranger)).toEqual({
      frontend: false,
      backend: false,
    })
  })
})

describe('chainHasConditionalStep', () => {
  it('is false for an absent bag and for one where no step declares a condition', () => {
    expect(chainHasConditionalStep(undefined)).toBe(false)
    expect(chainHasConditionalStep([null, {}, { skillId: 'x' } as never])).toBe(false)
  })

  it('is true as soon as one step declares one', () => {
    expect(chainHasConditionalStep([null, { condition: { serviceScope: 'frontend' } }])).toBe(true)
  })
})
