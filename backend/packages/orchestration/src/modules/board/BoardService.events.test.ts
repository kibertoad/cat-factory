import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { Block, BoardChange } from '@cat-factory/kernel'
import { boardChangeSubject } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// A board mutation on a service MOUNTED from another workspace must push its real-time
// `boardChanged` with the block's HOME workspace as the origin — not the acting (mounting)
// workspace. `FanOutEventPublisher` resolves the affected service (and thus every board that
// mounts it) by looking the block up under that origin, so emitting with the mounter's id
// would find nothing and silently collapse the fan-out to the one board that made the edit —
// defeating the cross-workspace live-sync this whole feature exists for.
describe('BoardService real-time origin for mounted (shared) services', () => {
  const ACTING = 'ws_actor' // the workspace performing the edit (mounts the service)
  const HOME = 'ws_home' // the workspace that physically homes the shared service's blocks
  const SERVICE_ID = 'svc_shared'

  type Emit = {
    workspaceId: string
    reason: string
    blockId: string | null
    originConnectionId: string | null
    /** The block the change CARRIED, if any: the difference between a targeted and a coarse one. */
    carried: Block | null
  }

  function build(blocks: Block[]) {
    const emits: Emit[] = []
    const byId = new Map(blocks.map((b) => [b.id, b]))

    const deps = {
      // requireWorkspace only needs a non-null workspace.
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        // Nothing is local to the acting workspace (it only MOUNTS the service); blocks
        // resolve at their home.
        get: async (ws: string, id: string) => (ws === HOME ? (byId.get(id) ?? null) : null),
        findById: async (id: string) => {
          const block = byId.get(id)
          return block ? { workspaceId: HOME, serviceId: SERVICE_ID, block } : null
        },
        listByWorkspace: async (ws: string) => (ws === HOME ? blocks : []),
        update: async () => {},
        insert: async () => {},
        setService: async () => {},
        deleteMany: async () => {},
      },
      // Sharing is wired: the acting workspace mounts the home's service.
      serviceRepository: {
        listByFrameBlocks: async (ids: string[]) =>
          ids.map((frameBlockId) => ({ id: SERVICE_ID, frameBlockId })),
        // Still used by the service-for-container resolution on the add/reparent paths.
        getByFrameBlock: async () => ({ id: SERVICE_ID }),
      },
      workspaceMountRepository: {
        // Only the ACTING board mounts the service, so a frame edit from elsewhere finds no mount.
        listByWorkspace: async (ws: string) =>
          ws === ACTING ? [{ workspaceId: ACTING, serviceId: SERVICE_ID }] : [],
        get: async (ws: string, serviceId: string) =>
          ws === ACTING && serviceId === SERVICE_ID ? { workspaceId: ws, serviceId } : null,
      },
      executionRepository: {},
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
      executionEventPublisher: {
        async executionChanged() {},
        async boardChanged(workspaceId: string, change: BoardChange) {
          emits.push({
            workspaceId,
            reason: change.reason,
            blockId: change.blockId ?? change.block?.id ?? null,
            originConnectionId: change.originConnectionId ?? null,
            carried: change.block ?? null,
          })
        },
        async bootstrapChanged() {},
        async notificationChanged() {},
        async llmCallObserved() {},
      },
    } as unknown as BoardServiceDependencies

    return { service: new BoardService(deps), emits }
  }

  function frame(id: string): Block {
    return {
      id,
      title: 'Shared service',
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
    }
  }

  function task(id: string, parentId: string): Block {
    return { ...frame(id), title: 'A task', level: 'task', parentId }
  }

  it('updateBlock emits with the home workspace, not the acting one', async () => {
    const { service, emits } = build([task('blk_shared', 'frame_shared')])
    await service.updateBlock(
      ACTING,
      'blk_shared',
      { title: 'Renamed live' },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    const e = emits.find((x) => x.reason === 'block-updated')
    expect(e).toBeDefined()
    expect(e?.workspaceId).toBe(HOME)
    expect(e?.blockId).toBe('blk_shared')
  })

  it('addTask emits with the home workspace, so siblings on every mount see the new task', async () => {
    const { service, emits } = build([frame('frame_shared')])
    const created = await service.addTask(
      ACTING,
      'frame_shared',
      { title: 'New shared task' },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    const e = emits.find((x) => x.reason === 'block-added')
    expect(e).toBeDefined()
    expect(e?.workspaceId).toBe(HOME)
    expect(e?.blockId).toBe(created.id)
  })

  it('updateBlock forwards the origin connection id so the acting tab is not echoed its own edit', async () => {
    const { service, emits } = build([task('blk_shared', 'frame_shared')])
    await service.updateBlock(
      ACTING,
      'blk_shared',
      { title: 'Renamed live' },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
      'cid-upd',
    )
    const e = emits.find((x) => x.reason === 'block-updated')
    expect(e).toBeDefined()
    // Home origin (fan-out to every mounting board) AND the acting connection carried through so
    // the realtime transport can suppress the redundant self-refresh.
    expect(e?.workspaceId).toBe(HOME)
    expect(e?.originConnectionId).toBe('cid-upd')
  })

  it('moveBlock forwards the origin connection id so the transport can suppress the self-echo', async () => {
    const { service, emits } = build([task('blk_shared', 'frame_shared')])
    await service.moveBlock(ACTING, 'blk_shared', { x: 5, y: 9 }, 'cid-abc')
    const e = emits.find((x) => x.reason === 'block-moved')
    expect(e).toBeDefined()
    expect(e?.workspaceId).toBe(HOME)
    expect(e?.originConnectionId).toBe('cid-abc')
  })

  it('reparent forwards the origin connection id', async () => {
    const { service, emits } = build([
      frame('frame_shared'),
      frame('frame_dest'),
      task('blk_shared', 'frame_shared'),
    ])
    await service.reparent(
      ACTING,
      'blk_shared',
      { parentId: 'frame_dest', position: { x: 1, y: 2 } },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
      'cid-xyz',
    )
    const e = emits.find((x) => x.reason === 'block-reparented')
    expect(e).toBeDefined()
    expect(e?.originConnectionId).toBe('cid-xyz')
  })

  it('toggleDependency emits with the home workspace of the target task', async () => {
    const a = task('blk_a', 'frame_shared')
    const b = task('blk_b', 'frame_shared')
    const { service, emits } = build([frame('frame_shared'), a, b])
    await service.toggleDependency(ACTING, 'blk_a', 'blk_b')
    const e = emits.find((x) => x.reason === 'dependency-toggled')
    expect(e).toBeDefined()
    expect(e?.workspaceId).toBe(HOME)
    expect(e?.blockId).toBe('blk_a')
  })
})

// Which mutations CARRY their block decides what a busy board costs: a carried block is one
// upsert on every subscriber, a bare signal is a full snapshot fetch per open board. The split is
// a judgement made per call site (is this change fully described by one block?), so it is pinned
// here rather than left to whoever edits the emit next.
describe('BoardService targeted vs coarse board changes', () => {
  const WS = 'ws_1'

  function build(blocks: Block[]) {
    const emits: { reason: string; carried: Block | null; subject: string | null }[] = []
    const byId = new Map(blocks.map((b) => [b.id, b]))
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        get: async (_ws: string, id: string) => byId.get(id) ?? null,
        findById: async (id: string) => {
          const block = byId.get(id)
          return block ? { workspaceId: WS, serviceId: null, block } : null
        },
        listByWorkspace: async () => blocks,
        update: async (_ws: string, id: string, patch: Partial<Block>) => {
          const existing = byId.get(id)
          if (existing) byId.set(id, { ...existing, ...patch })
        },
        insert: async () => {},
        setService: async () => {},
        deleteMany: async () => {},
        shiftChildPositions: async () => {},
      },
      executionRepository: { deleteByBlock: async () => {} },
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
      executionEventPublisher: {
        async executionChanged() {},
        async boardChanged(_ws: string, change: BoardChange) {
          emits.push({
            reason: change.reason,
            carried: change.block ?? null,
            subject: boardChangeSubject(change),
          })
        },
        async bootstrapChanged() {},
        async notificationChanged() {},
        async llmCallObserved() {},
      },
    } as unknown as BoardServiceDependencies
    return { service: new BoardService(deps), emits }
  }

  function frame(id: string): Block {
    return {
      id,
      title: 'Service',
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
    }
  }

  function task(id: string, parentId: string): Block {
    return { ...frame(id), title: 'A task', level: 'task', parentId }
  }

  it('carries the new task on addTask', async () => {
    const { service, emits } = build([frame('frame_1')])
    const created = await service.addTask(
      WS,
      'frame_1',
      { title: 'New task' },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    expect(emits.at(-1)?.carried?.id).toBe(created.id)
  })

  it('carries the edited block on updateBlock', async () => {
    const { service, emits } = build([task('blk_1', 'frame_1')])
    await service.updateBlock(WS, 'blk_1', { title: 'Renamed' }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY)
    const e = emits.find((x) => x.reason === 'block-updated')
    // The block as it is AFTER the write: carrying the pre-write object would push subscribers
    // the value the edit replaced, which is worse than not carrying one at all.
    expect(e?.carried?.title).toBe('Renamed')
  })

  it('carries the moved block on moveBlock', async () => {
    const { service, emits } = build([task('blk_1', 'frame_1')])
    await service.moveBlock(WS, 'blk_1', { x: 42, y: 7 })
    const e = emits.find((x) => x.reason === 'block-moved')
    expect(e?.carried?.position).toEqual({ x: 42, y: 7 })
  })

  it('does NOT carry a block for a removal', async () => {
    const { service, emits } = build([frame('frame_1'), task('blk_1', 'frame_1')])
    await service.removeBlock(WS, 'blk_1')
    const removals = emits.filter((x) => x.reason === 'block-removed')
    expect(removals.length).toBeGreaterThan(0)
    // A delete CASCADES over descendants and prunes dangling edges on blocks the event never
    // names, so the client has to re-read: a payload here would state only part of the change.
    expect(removals.every((x) => x.carried === null)).toBe(true)
  })

  it('does NOT carry a block for a reparent', async () => {
    const { service, emits } = build([frame('frame_1'), frame('frame_2'), task('blk_1', 'frame_1')])
    await service.reparent(
      WS,
      'blk_1',
      { parentId: 'frame_2', position: { x: 1, y: 2 } },
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    const e = emits.find((x) => x.reason === 'block-reparented')
    expect(e).toBeDefined()
    expect(e?.carried).toBeNull()
  })

  it('withholds the payload on a resize but still NAMES the block it resized', async () => {
    // Two different withholdings, and conflating them costs the fan-out. The PAYLOAD is withheld
    // because a resize also shifts the container's children, so a subscriber upserting the
    // container alone would draw it at its new size around contents still at the old offsets. The
    // SUBJECT must survive that: `FanOutEventPublisher` resolves the mounting workspaces from it,
    // so a change naming nobody reaches the acting board only, which is how a resized module
    // stopped reaching the other boards mounting its service at all.
    const { service, emits } = build([frame('frame_1'), task('blk_1', 'frame_1')])

    await service.resizeBlock(WS, 'blk_1', { position: { x: 5, y: 5 }, size: { w: 300, h: 200 } })

    const e = emits.find((x) => x.reason === 'block-updated')
    expect(e?.carried).toBeNull()
    expect(e?.subject).toBe('blk_1')
  })
})
