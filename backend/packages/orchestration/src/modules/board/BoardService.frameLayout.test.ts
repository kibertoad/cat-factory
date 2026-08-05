import { UNATTRIBUTED_BLOCK_EDITOR } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { Block, Service, WorkspaceMount } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

/**
 * A service frame's board position is a PER-WORKSPACE layout override on its mount, so the frame
 * block row keeps whatever coordinates it was created with forever. Every single-block mutation
 * response therefore has to be projected through the mount before it reaches the SPA, which
 * upserts the authoritative block a mutation returns: without that, resizing a frame (a
 * `size`-only `updateBlock`) hands back the row's stale position and the frame JUMPS to it.
 */
describe('BoardService — frame responses carry this board’s layout override', () => {
  const WS = 'ws_1'
  const CREATED_AT = { x: 10, y: 20 } // where the frame row was born
  const MOUNTED_AT = { x: 640, y: 480 } // where this board actually shows it

  function frame(over: Partial<Block> = {}): Block {
    return {
      id: 'frame_1',
      title: 'web',
      type: 'service',
      description: '',
      position: { ...CREATED_AT },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
      ...over,
    } as Block
  }

  function build(stored: Block, mountSize: { w: number; h: number } | null = null) {
    const mount: WorkspaceMount = {
      workspaceId: WS,
      serviceId: 'svc_1',
      position: { ...MOUNTED_AT },
      size: mountSize,
      createdAt: 0,
    }
    const mountPatches: Array<Partial<WorkspaceMount>> = []
    let current = stored
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        findById: async (id: string) =>
          id === current.id ? { workspaceId: WS, serviceId: 'svc_1', block: current } : null,
        get: async (_ws: string, id: string) => (id === current.id ? current : null),
        listByWorkspace: async () => [current],
        update: async (_ws: string, _id: string, patch: Partial<Block>) => {
          current = { ...current, ...patch }
        },
      },
      serviceRepository: {
        // `frameMount` resolves candidates by frame block id and then intersects them with THIS
        // board's mounts (a block id is not unique across boards), so the batched pair
        // `listByFrameBlocks` + `listByWorkspace` is what it actually calls.
        listByFrameBlocks: async (ids: string[]) =>
          ids.includes(current.id) ? [{ id: 'svc_1', frameBlockId: current.id } as Service] : [],
      },
      workspaceMountRepository: {
        listByWorkspace: async (ws: string) => (ws === WS ? [mount] : []),
        get: async (ws: string, serviceId: string) =>
          ws === WS && serviceId === 'svc_1' ? mount : null,
        update: async (_ws: string, _id: string, patch: Partial<WorkspaceMount>) => {
          mountPatches.push(patch)
          Object.assign(mount, patch)
        },
      },
      idGenerator: { next: (p: string) => `${p}_new` },
      clock: { now: () => 0 },
    } as unknown as BoardServiceDependencies
    return { service: new BoardService(deps), mountPatches, stored: () => current }
  }

  it('returns the mounted position from a size-only update (the resize jump)', async () => {
    const { service, stored } = build(frame())

    const updated = await service.updateBlock(
      WS,
      'frame_1',
      { size: { w: 900, h: 700 } },
      UNATTRIBUTED_BLOCK_EDITOR,
    )

    expect(updated.position).toEqual(MOUNTED_AT)
    expect(updated.size).toEqual({ w: 900, h: 700 })
    // The size itself is a field of the shared block, so it is still persisted there.
    expect(stored().size).toEqual({ w: 900, h: 700 })
  })

  it('returns the mounted position from any other frame edit', async () => {
    const { service } = build(frame())

    const updated = await service.updateBlock(
      WS,
      'frame_1',
      { title: 'renamed' },
      UNATTRIBUTED_BLOCK_EDITOR,
    )

    expect(updated.title).toBe('renamed')
    expect(updated.position).toEqual(MOUNTED_AT)
  })

  it('leaves a non-frame block untouched (its position IS on the block)', async () => {
    const task = frame({ id: 'task_1', level: 'task', parentId: 'frame_1' })
    const { service } = build(task)

    const updated = await service.updateBlock(
      WS,
      'task_1',
      { title: 'renamed' },
      UNATTRIBUTED_BLOCK_EDITOR,
    )

    expect(updated.position).toEqual(CREATED_AT)
  })

  it('carries the mount size override back from a frame move', async () => {
    const { service, mountPatches, stored } = build(frame(), { w: 900, h: 700 })

    const moved = await service.moveBlock(WS, 'frame_1', { x: 1, y: 2 })

    expect(mountPatches).toEqual([{ position: { x: 1, y: 2 } }])
    expect(moved.position).toEqual({ x: 1, y: 2 })
    expect(moved.size).toEqual({ w: 900, h: 700 })
    // A frame move writes the mount, never the shared block.
    expect(stored().position).toEqual(CREATED_AT)
  })

  it('returns the mounted position when a frame is archived and restored', async () => {
    const { service } = build(frame())

    expect((await service.archiveBlock(WS, 'frame_1')).position).toEqual(MOUNTED_AT)
    expect((await service.restoreBlock(WS, 'frame_1')).position).toEqual(MOUNTED_AT)
  })
})
