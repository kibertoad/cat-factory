import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { Block, BinaryArtifactStore } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

/**
 * A cross-home reparent moves a subtree's ROWS to the destination service's home, and the images
 * attached to its tasks have to follow: every reader (the inspector, a dispatch, the block delete)
 * lists them at the task's home, so rows left at the old one read as a task that lost its images.
 */
describe('BoardService.reparent: a cross-home move carries the attached images', () => {
  const SRC = 'ws_src'
  const DEST = 'ws_dest'

  const block = (id: string, over: Partial<Block> = {}): Block =>
    ({
      id,
      title: id,
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: null,
      ...over,
    }) as Block

  function build(store: Partial<BinaryArtifactStore> | (() => Promise<never>)) {
    const rows: Record<string, Block[]> = {
      [SRC]: [
        block('frame_src', { level: 'frame' }),
        block('mod_1', { level: 'module', parentId: 'frame_src' }),
        block('task_1', { parentId: 'mod_1' }),
      ],
      [DEST]: [block('frame_dest', { level: 'frame' })],
    }
    const homedWhenMoved: string[][] = []
    const logger = createRecordingLogger()
    const moveBlocks = async (workspaceIds: readonly string[], blockIds: readonly string[]) => {
      // The images move while the blocks exist at BOTH homes, so no sweep sees either as orphaned.
      homedWhenMoved.push(
        Object.entries(rows)
          .filter(([, blocks]) => blocks.some((b) => b.id === 'task_1'))
          .map(([ws]) => ws),
      )
      return (store as Partial<BinaryArtifactStore>).moveBlocks!(
        workspaceIds as [string, string],
        blockIds,
      )
    }
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        get: async (ws: string, id: string) => rows[ws]?.find((b) => b.id === id) ?? null,
        findById: async (id: string) => {
          for (const [ws, blocks] of Object.entries(rows)) {
            const found = blocks.find((b) => b.id === id)
            if (found) return { workspaceId: ws, serviceId: `svc_${ws}`, block: found }
          }
          return null
        },
        listByWorkspace: async (ws: string) => rows[ws] ?? [],
        insert: async (ws: string, b: Block) => {
          rows[ws] = [...(rows[ws] ?? []), b]
        },
        update: async () => {},
        deleteMany: async (ws: string, ids: string[]) => {
          rows[ws] = (rows[ws] ?? []).filter((b) => !ids.includes(b.id))
        },
        setService: async () => {},
      },
      executionRepository: {
        getByBlock: async () => null,
        deleteByBlock: async () => {},
        upsert: async () => {},
      },
      serviceRepository: { getByFrameBlock: async (id: string) => ({ id: `svc_${id}` }) },
      workspaceMountRepository: {
        get: async (ws: string, serviceId: string) =>
          ws === SRC && serviceId === `svc_${DEST}` ? { workspaceId: ws, serviceId } : null,
        listWorkspaceIdsMountingBlock: async () => [],
      },
      riskPolicyRepository: { list: async () => [] },
      resolveBinaryArtifactStore:
        typeof store === 'function' ? store : async () => ({ ...store, moveBlocks }),
      logger,
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
    } as unknown as BoardServiceDependencies
    return { service: new BoardService(deps), rows, homedWhenMoved, logger }
  }

  it('re-keys every moved block to the destination home, while both homes hold it', async () => {
    const moves: { from: string; to: string; ids: string[] }[] = []
    const { service, rows, homedWhenMoved } = build({
      moveBlocks: async (workspaceIds, blockIds) => {
        moves.push({ from: workspaceIds[0], to: workspaceIds[1], ids: [...blockIds] })
        return 1
      },
    })
    await service.reparent(
      SRC,
      'mod_1',
      { parentId: 'frame_dest', position: { x: 0, y: 0 } },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    expect(moves).toEqual([{ from: SRC, to: DEST, ids: ['mod_1', 'task_1'] }])
    expect(homedWhenMoved).toEqual([[SRC, DEST]])
    expect(rows[DEST]?.some((b) => b.id === 'task_1')).toBe(true)
  })

  it('still moves the task when the store is unreachable, and says so', async () => {
    const { service, rows, logger } = build(async () => {
      throw new Error('account settings unreachable')
    })
    await service.reparent(
      SRC,
      'mod_1',
      { parentId: 'frame_dest', position: { x: 0, y: 0 } },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    expect(rows[DEST]?.some((b) => b.id === 'task_1')).toBe(true)
    expect(logger.lines.some((line) => line.level === 'warn')).toBe(true)
  })
})
