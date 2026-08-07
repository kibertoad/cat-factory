import { describe, expect, it } from 'vitest'
import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import type { Block } from '@cat-factory/kernel'
import { NotFoundError, ValidationError } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// The public-API board reads/writes (`listServices` / `getServiceTask` / `listServiceTasksPage` /
// `addServiceTask`) back the external `/api/v1` services+tasks surface. They are pure, workspace-
// scoped projections over the bounded block reads that must exclude headless `internal` anchors
// and treat archived services consistently. The Worker integration spec covers the wire round-trip;
// these assert the projection/guard logic directly, independent of the runtime facades.
describe('BoardService — public-API board reads/writes', () => {
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

  /** A BoardService over in-memory, workspace-scoped blocks (foreign workspaces read empty). */
  function build(blocks: Block[]) {
    const blocksMap = new Map(blocks.map((b) => [b.id, b]))
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }), accountOf: async () => 'acc_1' },
      blockRepository: {
        get: async (ws: string, id: string) => (ws === WS ? (blocksMap.get(id) ?? null) : null),
        listByWorkspace: async (ws: string) => (ws === WS ? [...blocksMap.values()] : []),
        // In-memory stand-in for the BOUNDED subtree read the paginated task list uses. It
        // reproduces the repositories' contract (frame + its modules, id-ordered, exclusive
        // `afterId`, `internal` anchors excluded, hard `limit`) so the service's paging arithmetic
        // is exercised for real; the D1 ⇄ Drizzle SQL is pinned by the conformance suite instead.
        listServiceTasks: async (
          ws: string,
          frameId: string,
          opts: { limit: number; afterId?: string; status?: string },
        ) => {
          if (ws !== WS) return []
          const parents = new Set([
            frameId,
            ...[...blocksMap.values()]
              .filter((b) => b.parentId === frameId && b.level === 'module')
              .map((b) => b.id),
          ])
          return [...blocksMap.values()]
            .filter(
              (b) =>
                b.level === 'task' &&
                !b.internal &&
                b.parentId != null &&
                parents.has(b.parentId) &&
                (!opts.status || b.status === opts.status) &&
                (!opts.afterId || b.id > opts.afterId),
            )
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, opts.limit)
        },
      },
    } as unknown as BoardServiceDependencies
    return new BoardService(deps)
  }

  // A representative board: a visible service (f1) with a module (m1); a task under the frame
  // (t1) and one nested under the module (t2); a headless internal anchor task (t3); an internal
  // frame (f2); and an archived service (f3) with a task (t4).
  function seed(): Block[] {
    return [
      block('f1'),
      block('m1', { level: 'module', parentId: 'f1' }),
      block('t1', { level: 'task', parentId: 'f1' }),
      block('t2', { level: 'task', parentId: 'm1' }),
      block('t3', { level: 'task', parentId: 'f1', internal: true }),
      block('f2', { internal: true }),
      block('f3', { archived: true }),
      block('t4', { level: 'task', parentId: 'f3' }),
    ]
  }

  describe('listServices', () => {
    it('returns only visible service frames (excludes internal, archived, non-frames)', async () => {
      const ids = (await build(seed()).listServices(WS)).map((b) => b.id)
      expect(ids).toEqual(['f1'])
    })
  })

  describe('getServiceTask', () => {
    it('resolves the enclosing service frame for a frame- and a module-nested task', async () => {
      const svc = build(seed())
      expect((await svc.getServiceTask(WS, 't1'))?.service.id).toBe('f1')
      // t2 → m1 (module) → f1 (frame): serviceOf walks up to the top-level frame.
      expect((await svc.getServiceTask(WS, 't2'))?.service.id).toBe('f1')
    })

    it('still resolves a task under an ARCHIVED service (reads survive archiving)', async () => {
      const found = await build(seed()).getServiceTask(WS, 't4')
      expect(found?.service.id).toBe('f3')
      expect(found?.service.archived).toBe(true)
    })

    it('returns null for unknown / non-task / internal-anchor ids', async () => {
      const svc = build(seed())
      expect(await svc.getServiceTask(WS, 'nope')).toBeNull()
      expect(await svc.getServiceTask(WS, 'f1')).toBeNull() // a frame, not a task
      expect(await svc.getServiceTask(WS, 't3')).toBeNull() // headless internal anchor
    })
  })

  describe('listServiceTasksPage', () => {
    const page = (limit = 50, over: { afterId?: string; status?: Block['status'] } = {}) => ({
      limit,
      ...over,
    })

    it('lists the whole subtree (frame + module tasks), excluding internal anchors', async () => {
      const got = await build(seed()).listServiceTasksPage(WS, 'f1', page())
      expect(got?.tasks.map((b) => b.id)).toEqual(['t1', 't2']) // t3 (internal) excluded
      expect(got?.hasMore).toBe(false)
    })

    it('pages through the subtree on the id keyset without skipping or repeating a task', async () => {
      const svc = build(seed())
      const first = await svc.listServiceTasksPage(WS, 'f1', page(1))
      expect(first?.tasks.map((b) => b.id)).toEqual(['t1'])
      // `hasMore` comes from the extra row the service asks for, so it needs no second query.
      expect(first?.hasMore).toBe(true)

      const second = await svc.listServiceTasksPage(WS, 'f1', page(1, { afterId: 't1' }))
      expect(second?.tasks.map((b) => b.id)).toEqual(['t2'])
      // The last page reports no more, so the caller emits a null cursor and stops.
      expect(second?.hasMore).toBe(false)
    })

    it('filters to one status', async () => {
      const blocks = seed()
      blocks.find((b) => b.id === 't2')!.status = 'done'
      const got = await build(blocks).listServiceTasksPage(WS, 'f1', page(50, { status: 'done' }))
      expect(got?.tasks.map((b) => b.id)).toEqual(['t2'])
    })

    it('returns null for a missing / non-frame / internal / archived service', async () => {
      const svc = build(seed())
      expect(await svc.listServiceTasksPage(WS, 'nope', page())).toBeNull()
      expect(await svc.listServiceTasksPage(WS, 't1', page())).toBeNull() // a task, not a frame
      expect(await svc.listServiceTasksPage(WS, 'f2', page())).toBeNull() // internal
      expect(await svc.listServiceTasksPage(WS, 'f3', page())).toBeNull() // archived
    })
  })

  describe('addServiceTask (guards before delegating to addTask)', () => {
    it('rejects a missing or internal-frame container as not found', async () => {
      const svc = build(seed())
      await expect(
        svc.addServiceTask(WS, 'nope', { title: 'x' }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY),
      ).rejects.toBeInstanceOf(NotFoundError)
      await expect(
        svc.addServiceTask(WS, 'f2', { title: 'x' }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY),
      ).rejects.toBeInstanceOf(NotFoundError)
    })

    it('rejects a non-frame container and an archived service', async () => {
      const svc = build(seed())
      await expect(
        svc.addServiceTask(WS, 't1', { title: 'x' }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY),
      ).rejects.toBeInstanceOf(ValidationError)
      await expect(
        svc.addServiceTask(WS, 'f3', { title: 'x' }, UNATTRIBUTED_BLOCK_EDIT_AUTHORITY),
      ).rejects.toBeInstanceOf(ValidationError)
    })
  })
})
