import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import { NotFoundError, ValidationError } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// The public-API board reads/writes (`listServices` / `getServiceTask` / `listServiceTasks` /
// `addServiceTask`) back the external `/api/v1` services+tasks surface. They are pure, workspace-
// scoped projections over `listByWorkspace` / `get` that must exclude headless `internal` anchors
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

  describe('listServiceTasks', () => {
    it('lists the whole subtree (frame + module tasks), excluding internal anchors', async () => {
      const ids = (await build(seed()).listServiceTasks(WS, 'f1'))?.map((b) => b.id)
      expect(new Set(ids)).toEqual(new Set(['t1', 't2'])) // t3 (internal) excluded
    })

    it('returns null for a missing / non-frame / internal / archived service', async () => {
      const svc = build(seed())
      expect(await svc.listServiceTasks(WS, 'nope')).toBeNull()
      expect(await svc.listServiceTasks(WS, 't1')).toBeNull() // a task, not a frame
      expect(await svc.listServiceTasks(WS, 'f2')).toBeNull() // internal
      expect(await svc.listServiceTasks(WS, 'f3')).toBeNull() // archived
    })
  })

  describe('addServiceTask (guards before delegating to addTask)', () => {
    it('rejects a missing or internal-frame container as not found', async () => {
      const svc = build(seed())
      await expect(svc.addServiceTask(WS, 'nope', { title: 'x' })).rejects.toBeInstanceOf(
        NotFoundError,
      )
      await expect(svc.addServiceTask(WS, 'f2', { title: 'x' })).rejects.toBeInstanceOf(
        NotFoundError,
      )
    })

    it('rejects a non-frame container and an archived service', async () => {
      const svc = build(seed())
      await expect(svc.addServiceTask(WS, 't1', { title: 'x' })).rejects.toBeInstanceOf(
        ValidationError,
      )
      await expect(svc.addServiceTask(WS, 'f3', { title: 'x' })).rejects.toBeInstanceOf(
        ValidationError,
      )
    })
  })
})
