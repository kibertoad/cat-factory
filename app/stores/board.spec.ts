import { describe, it, expect, beforeEach } from 'vitest'
import type { Block, BlockStatus } from '~/types/domain'
import { useBoardStore } from '~/stores/board'

/** Minimal Block factory — only the fields the read getters care about. */
function block(id: string, over: Partial<Block> = {}): Block {
  return {
    id,
    title: id,
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
    ...over,
  }
}

const frame = (id: string, over: Partial<Block> = {}) => block(id, { level: 'frame', ...over })
const moduleBlock = (id: string, parentId: string, over: Partial<Block> = {}) =>
  block(id, { level: 'module', parentId, ...over })
const task = (id: string, parentId: string, over: Partial<Block> = {}) =>
  block(id, { level: 'task', parentId, ...over })

describe('board store read getters', () => {
  let store: ReturnType<typeof useBoardStore>
  beforeEach(() => {
    store = useBoardStore()
  })

  it('byId / getBlock index blocks by id', () => {
    store.hydrate([frame('f1'), task('t1', 'f1')])
    expect(store.getBlock('f1')?.id).toBe('f1')
    expect(store.getBlock('t1')?.level).toBe('task')
    expect(store.getBlock('missing')).toBeUndefined()
  })

  it('frames returns only top-level blocks (level absent defaults to frame)', () => {
    const legacy = block('legacy')
    // @ts-expect-error simulate legacy/persisted data without a level
    delete legacy.level
    store.hydrate([frame('f1'), moduleBlock('m1', 'f1'), task('t1', 'f1'), legacy])
    expect(store.frames.map((b) => b.id).sort()).toEqual(['f1', 'legacy'])
  })

  it('allTasks returns every task across the board', () => {
    store.hydrate([frame('f1'), task('t1', 'f1'), moduleBlock('m1', 'f1'), task('t2', 'm1')])
    expect(store.allTasks.map((b) => b.id).sort()).toEqual(['t1', 't2'])
  })

  it('childrenOf / tasksOf / modulesOf filter by parent and level', () => {
    store.hydrate([frame('f1'), moduleBlock('m1', 'f1'), task('t1', 'f1'), task('t2', 'm1')])
    expect(
      store
        .childrenOf('f1')
        .map((b) => b.id)
        .sort(),
    ).toEqual(['m1', 't1'])
    expect(store.tasksOf('f1').map((b) => b.id)).toEqual(['t1'])
    expect(store.modulesOf('f1').map((b) => b.id)).toEqual(['m1'])
    expect(store.tasksOf('m1').map((b) => b.id)).toEqual(['t2'])
  })

  it('allTasksUnder includes direct tasks and tasks nested in modules', () => {
    store.hydrate([
      frame('f1'),
      task('t1', 'f1'),
      moduleBlock('m1', 'f1'),
      task('t2', 'm1'),
      task('t3', 'm1'),
    ])
    expect(
      store
        .allTasksUnder('f1')
        .map((b) => b.id)
        .sort(),
    ).toEqual(['t1', 't2', 't3'])
    expect(
      store
        .allTasksUnder('m1')
        .map((b) => b.id)
        .sort(),
    ).toEqual(['t2', 't3'])
  })

  it('serviceOf walks up to the owning top-level frame', () => {
    store.hydrate([frame('f1'), moduleBlock('m1', 'f1'), task('t1', 'm1'), task('t2', 'f1')])
    expect(store.serviceOf(store.getBlock('t1')!)?.id).toBe('f1')
    expect(store.serviceOf(store.getBlock('t2')!)?.id).toBe('f1')
    expect(store.serviceOf(store.getBlock('m1')!)?.id).toBe('f1')
    expect(store.serviceOf(store.getBlock('f1')!)?.id).toBe('f1')
  })

  describe('dependencies', () => {
    const status = (s: BlockStatus) => ({ status: s })
    beforeEach(() => {
      store.hydrate([
        frame('f1'),
        task('done', 'f1', status('done')),
        task('open', 'f1', status('in_progress')),
        task('t', 'f1', { dependsOn: ['done', 'open', 'ghost'] }),
      ])
    })

    it('unmetDeps lists existing dependencies that are not done', () => {
      expect(store.unmetDeps('t').map((b) => b.id)).toEqual(['open'])
    })

    it('isRunnable is true only when no dependency is outstanding', () => {
      expect(store.isRunnable('t')).toBe(false)
      expect(store.isRunnable('done')).toBe(true)
    })
  })

  describe('frameStatus', () => {
    const seed = (...statuses: BlockStatus[]) =>
      store.hydrate([frame('f1'), ...statuses.map((s, i) => task(`t${i}`, 'f1', { status: s }))])

    it('is planned when there are no tasks', () => {
      store.hydrate([frame('f1')])
      expect(store.frameStatus('f1')).toBe('planned')
    })

    it('is blocked when any task is blocked (highest priority)', () => {
      seed('done', 'in_progress', 'blocked')
      expect(store.frameStatus('f1')).toBe('blocked')
    })

    it('is in_progress when a task is running or has an open PR', () => {
      seed('done', 'pr_ready')
      expect(store.frameStatus('f1')).toBe('in_progress')
      seed('ready', 'in_progress')
      expect(store.frameStatus('f1')).toBe('in_progress')
    })

    it('is ready when there are tasks but none active', () => {
      seed('done', 'ready')
      expect(store.frameStatus('f1')).toBe('ready')
    })
  })

  describe('frameProgress', () => {
    it("falls back to the frame's own progress when it has no tasks", () => {
      store.hydrate([frame('f1', { progress: 0.42 })])
      expect(store.frameProgress('f1')).toBe(0.42)
    })

    it('averages task progress, counting done as 1', () => {
      store.hydrate([
        frame('f1'),
        task('t1', 'f1', { status: 'done', progress: 0 }),
        task('t2', 'f1', { status: 'in_progress', progress: 0.5 }),
      ])
      expect(store.frameProgress('f1')).toBeCloseTo(0.75)
    })
  })

  describe('containerSize', () => {
    it('returns base dimensions for an empty service', () => {
      store.hydrate([frame('f1')])
      expect(store.containerSize('f1')).toEqual({ w: 360, h: 220 })
    })

    it('grows to fit a task and adds the module header height for modules', () => {
      store.hydrate([
        frame('f1'),
        moduleBlock('m1', 'f1', { position: { x: 0, y: 0 } }),
        task('t1', 'm1', { position: { x: 300, y: 200 } }),
      ])
      // module inner width/height fit the task, plus the 30px module header.
      const size = store.containerSize('m1')
      expect(size.w).toBe(300 + 180 + 12)
      expect(size.h).toBe(200 + 160 + 12 + 30)
    })

    it('expands a service to enclose its nested modules', () => {
      store.hydrate([frame('f1'), moduleBlock('m1', 'f1', { position: { x: 400, y: 300 } })])
      const mod = store.containerSize('m1')
      const svc = store.containerSize('f1')
      expect(svc.w).toBe(400 + mod.w + 12)
      expect(svc.h).toBe(300 + mod.h + 12)
    })
  })

  it('hydrate replaces and upsert inserts/updates cached blocks', () => {
    store.hydrate([frame('f1')])
    store.upsert(task('t1', 'f1', { title: 'first' }))
    expect(store.getBlock('t1')?.title).toBe('first')
    store.upsert(task('t1', 'f1', { title: 'second' }))
    expect(store.getBlock('t1')?.title).toBe('second')
    expect(store.allTasks).toHaveLength(1)
  })
})
