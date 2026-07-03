import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// Service connections are validated at the ONE write gate (updateBlock): targets must be
// service frames, tasks may only involve connected neighbors, and the fields are silently
// dropped on blocks of the wrong level/type so they never persist as dead data. Deleting a
// frame must prune the edges/selections that point at it (like dependsOn/epicId).
describe('BoardService service-connection guards', () => {
  const WS = 'ws_1'

  function block(id: string, over: Partial<Block> = {}): Block {
    return {
      id,
      title: id,
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
      ...over,
    }
  }

  function build(blocks: Block[]) {
    const byId = new Map(blocks.map((b) => [b.id, b]))
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (byId.get(id) ?? null) : null),
        findById: async (id: string) => {
          const found = byId.get(id)
          return found ? { workspaceId: WS, serviceId: null, block: found } : null
        },
        listByWorkspace: async (ws: string) => (ws === WS ? [...byId.values()] : []),
        update: async (_ws: string, id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch })
          const cur = byId.get(id)
          if (cur) byId.set(id, { ...cur, ...patch })
        },
        deleteMany: async (_ws: string, ids: string[]) => {
          for (const id of ids) byId.delete(id)
        },
      },
      executionRepository: { deleteByBlock: async () => {}, getByBlock: async () => null },
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
      executionEventPublisher: {
        async executionChanged() {},
        async boardChanged() {},
        async bootstrapChanged() {},
        async notificationChanged() {},
        async llmCallObserved() {},
      },
    } as unknown as BoardServiceDependencies
    return { service: new BoardService(deps), updates, byId }
  }

  it('accepts and persists a valid connection between two service frames', async () => {
    const { service } = build([block('a'), block('b')])
    const updated = await service.updateBlock(WS, 'a', {
      serviceConnections: [{ serviceBlockId: 'b', description: 'sends email via it' }],
    })
    expect(updated.serviceConnections).toEqual([
      { serviceBlockId: 'b', description: 'sends email via it' },
    ])
  })

  it('rejects a self-connection with a ValidationError', async () => {
    const { service } = build([block('a')])
    await expect(
      service.updateBlock(WS, 'a', { serviceConnections: [{ serviceBlockId: 'a' }] }),
    ).rejects.toThrow(/itself/)
  })

  it('rejects a connection to a non-service frame', async () => {
    const { service } = build([block('a'), block('f', { type: 'frontend' })])
    await expect(
      service.updateBlock(WS, 'a', { serviceConnections: [{ serviceBlockId: 'f' }] }),
    ).rejects.toThrow(/not a service/)
  })

  it('drops serviceConnections silently on a task-level patch', async () => {
    const { service, updates } = build([block('a'), block('t', { level: 'task', parentId: 'a' })])
    await service.updateBlock(WS, 't', {
      title: 'Renamed',
      serviceConnections: [{ serviceBlockId: 'a' }],
    })
    expect(updates[0]?.patch).toEqual({ title: 'Renamed' })
  })

  it('accepts involved services connected in either direction and rejects unconnected ones', async () => {
    const blocks = [
      block('own', { serviceConnections: [{ serviceBlockId: 'provider' }] }),
      block('provider'),
      block('consumer', { serviceConnections: [{ serviceBlockId: 'own' }] }),
      block('unrelated'),
      block('t', { level: 'task', parentId: 'own' }),
    ]
    const { service } = build(blocks)
    const updated = await service.updateBlock(WS, 't', {
      involvedServiceIds: ['provider', 'consumer'],
    })
    expect(updated.involvedServiceIds).toEqual(['provider', 'consumer'])
    await expect(
      service.updateBlock(WS, 't', { involvedServiceIds: ['unrelated'] }),
    ).rejects.toThrow(/not connected/)
  })

  it('drops involvedServiceIds silently on a frame-level patch', async () => {
    const { service, updates } = build([block('a'), block('b')])
    await service.updateBlock(WS, 'a', { title: 'Renamed', involvedServiceIds: ['b'] })
    expect(updates[0]?.patch).toEqual({ title: 'Renamed' })
  })

  it('accepts an involved service reachable only via a cross-home mounted consumer (incoming edge)', async () => {
    // The task's own frame lives here (WS); the CONSUMER frame that names it is homed in
    // another workspace and mounted into WS via a service. The SPA offers it (it computes
    // neighbors over the composed board), so the write gate must resolve it cross-home too —
    // a `listByWorkspace(WS)` read alone would miss the incoming edge and 422 a valid pick.
    const own = block('own')
    const task = block('t', { level: 'task', parentId: 'own' })
    const foreignConsumer = block('foreign', { serviceConnections: [{ serviceBlockId: 'own' }] })
    const local = new Map([own, task].map((b) => [b.id, b] as const))
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }) },
      serviceRepository: {},
      workspaceMountRepository: {
        get: async () => ({ workspaceId: WS, serviceId: 'svc_foreign' }),
      },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (local.get(id) ?? null) : null),
        findById: async (id: string) =>
          id === 'foreign'
            ? { workspaceId: 'ws_other', serviceId: 'svc_foreign', block: foreignConsumer }
            : null,
        listByWorkspace: async (ws: string) => (ws === WS ? [...local.values()] : []),
        update: async (_ws: string, id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch })
          const cur = local.get(id)
          if (cur) local.set(id, { ...cur, ...patch })
        },
      },
      executionRepository: { deleteByBlock: async () => {}, getByBlock: async () => null },
      idGenerator: { next: (prefix: string) => `${prefix}_new` },
      clock: { now: () => 0 },
      executionEventPublisher: {
        async executionChanged() {},
        async boardChanged() {},
        async bootstrapChanged() {},
        async notificationChanged() {},
        async llmCallObserved() {},
      },
    } as unknown as BoardServiceDependencies
    const service = new BoardService(deps)
    const updated = await service.updateBlock(WS, 't', { involvedServiceIds: ['foreign'] })
    expect(updated.involvedServiceIds).toEqual(['foreign'])
  })

  it('deleting a frame prunes connections and involved selections pointing at it', async () => {
    const blocks = [
      block('own', {
        serviceConnections: [{ serviceBlockId: 'doomed' }, { serviceBlockId: 'kept' }],
      }),
      block('doomed'),
      block('kept'),
      block('t', { level: 'task', parentId: 'own', involvedServiceIds: ['doomed', 'kept'] }),
    ]
    const { service, byId } = build(blocks)
    await service.removeBlock(WS, 'doomed')
    expect(byId.get('own')?.serviceConnections).toEqual([{ serviceBlockId: 'kept' }])
    expect(byId.get('t')?.involvedServiceIds).toEqual(['kept'])
  })
})
