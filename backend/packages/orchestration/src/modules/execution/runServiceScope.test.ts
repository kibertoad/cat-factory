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

/**
 * A board the product could actually save: a frontend frame, two connected SERVICE frames, and a
 * task under each. The connection runs service→service on purpose — `serviceConnectionsError`
 * refuses any other target and the patch narrowing drops the field on any other owner, so a
 * frontend frame has no connection in either direction and can never be an involved service. A
 * fixture that connected `frame_api` to `frame_ui` would assert a scope no board can produce.
 */
function board(): Block[] {
  return [
    block({ id: 'frame_ui', type: 'frontend', level: 'frame' }),
    block({
      id: 'frame_api',
      type: 'service',
      level: 'frame',
      serviceConnections: [{ serviceBlockId: 'frame_billing' }],
    }),
    block({ id: 'frame_billing', type: 'service', level: 'frame' }),
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
    // `frameOf` does not answer null here: with no frame ancestor it falls back to the parent-less
    // block, which IS this task. Classifying that by its own `type` would read an orphan as a
    // backend service and silently drop the UI pass, so the resolved ancestor is checked to be a
    // frame and an unclassifiable task gets the empty scope that runs BOTH passes.
    const orphan = board().find((b) => b.id === 'orphan')!
    expect(await resolveScopeForRun(listBlocks, WS, orphan)).toEqual({
      frontend: false,
      backend: false,
    })
  })

  it('resolves an EMPTY scope when the parent chain stops on a module', async () => {
    // The other shape `frameOf` returns a non-frame for: a broken link, where the walk ends on the
    // last block it could reach. Same fail-safe rather than a module classified as a service.
    const blocks = [
      ...board(),
      block({ id: 'module_orphan', level: 'module', parentId: 'frame_missing' }),
    ]
    const task = block({ id: 'task_in_module', parentId: 'module_orphan' })
    expect(await resolveScopeForRun(async () => [...blocks, task], WS, task)).toEqual({
      frontend: false,
      backend: false,
    })
  })

  it('keeps the backend scope when a service task names an involved service peer', async () => {
    // Every involved peer is a `service` frame by construction (only a service frame may declare or
    // be named by a connection), so the peer term can confirm `backend` and never introduce
    // `frontend`. Asserted so a future widening of the connection model shows up here as a change.
    const task = block({
      id: 'task_api',
      parentId: 'frame_api',
      involvedServiceIds: ['frame_billing'],
    })
    expect(await resolveScopeForRun(listBlocks, WS, task)).toEqual({
      frontend: false,
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
