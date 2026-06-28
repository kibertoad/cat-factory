import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
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

  type Emit = { workspaceId: string; reason: string; blockId: string | null }

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
      },
      // Sharing is wired: the acting workspace mounts the home's service.
      serviceRepository: { getByFrameBlock: async () => ({ id: SERVICE_ID }) },
      workspaceMountRepository: {
        get: async (ws: string, serviceId: string) =>
          ws === ACTING && serviceId === SERVICE_ID ? { workspaceId: ws, serviceId } : null,
      },
      executionRepository: {},
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
      executionEventPublisher: {
        async executionChanged() {},
        async boardChanged(workspaceId: string, reason: string, blockId?: string | null) {
          emits.push({ workspaceId, reason, blockId: blockId ?? null })
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
    await service.updateBlock(ACTING, 'blk_shared', { title: 'Renamed live' })
    const e = emits.find((x) => x.reason === 'block-updated')
    expect(e).toBeDefined()
    expect(e?.workspaceId).toBe(HOME)
    expect(e?.blockId).toBe('blk_shared')
  })

  it('addTask emits with the home workspace, so siblings on every mount see the new task', async () => {
    const { service, emits } = build([frame('frame_shared')])
    const created = await service.addTask(ACTING, 'frame_shared', { title: 'New shared task' })
    const e = emits.find((x) => x.reason === 'block-added')
    expect(e).toBeDefined()
    expect(e?.workspaceId).toBe(HOME)
    expect(e?.blockId).toBe(created.id)
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
