import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { Block, BlockStatus } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useWorkspaceStore } from '~/stores/workspace'

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

  it('descendantsOf returns the transitive structural subtree, excluding the root', () => {
    store.hydrate([
      frame('f1'),
      moduleBlock('m1', 'f1'),
      task('t1', 'f1'),
      task('t2', 'm1'),
      frame('f2'),
      task('t3', 'f2'),
    ])
    expect(
      store
        .descendantsOf('f1')
        .map((b) => b.id)
        .sort(),
    ).toEqual(['m1', 't1', 't2'])
    // a leaf task has no descendants; unknown ids are a safe empty
    expect(store.descendantsOf('t1')).toEqual([])
    expect(store.descendantsOf('missing')).toEqual([])
  })

  it('epicMembers groups blocks by their epicId (indexed lookup)', () => {
    store.hydrate([
      frame('f1'),
      block('e1', { level: 'epic' }),
      task('t1', 'f1', { epicId: 'e1' }),
      task('t2', 'f1', { epicId: 'e1' }),
      task('t3', 'f1'),
    ])
    expect(
      store
        .epicMembers('e1')
        .map((b) => b.id)
        .sort(),
    ).toEqual(['t1', 't2'])
    expect(store.epicMembers('none')).toEqual([])
  })

  it('hydrate reuses the existing object for an unchanged block (stable identity)', () => {
    store.hydrate([frame('f1'), task('t1', 'f1', { title: 'a' })])
    const before = store.getBlock('t1')
    // Re-hydrate with an equal-but-distinct snapshot: identity is preserved so unchanged
    // blocks don't force a re-render on a coarse full refresh.
    store.hydrate([frame('f1'), task('t1', 'f1', { title: 'a' })])
    expect(store.getBlock('t1')).toBe(before)
    // A block whose content changed gets the fresh object.
    store.hydrate([frame('f1'), task('t1', 'f1', { title: 'b' })])
    expect(store.getBlock('t1')).not.toBe(before)
    expect(store.getBlock('t1')?.title).toBe('b')
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
      expect(size.w).toBe(300 + 210 + 12)
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

  it('previewMove updates a block position locally without persisting', () => {
    store.hydrate([frame('f1'), task('t1', 'f1', { position: { x: 0, y: 0 } })])
    store.previewMove('t1', { x: 120, y: 40 })
    expect(store.getBlock('t1')?.position).toEqual({ x: 120, y: 40 })
    // a no-op for unknown ids (no throw)
    expect(() => store.previewMove('missing', { x: 1, y: 1 })).not.toThrow()
  })

  it('updateBlock restores the patched fields and toasts when the write fails', async () => {
    // Capture the toast the store surfaces on failure. Re-stub before creating the store so it
    // binds this spy (the store resolves `useToast()` once at setup).
    const addSpy = vi.fn()
    vi.stubGlobal('useToast', () => ({ add: addSpy }))
    setActivePinia(createPinia())
    const s = useBoardStore()
    s.hydrate([frame('f1', { title: 'Original', description: 'orig' })])
    // With no active workspace, `requireId()` throws inside updateBlock's try — the same catch
    // that a rejected API write hits — so this exercises the optimistic-rollback + toast path.
    await s.updateBlock('f1', { title: 'Edited', description: 'changed' })
    expect(s.getBlock('f1')?.title).toBe('Original')
    expect(s.getBlock('f1')?.description).toBe('orig')
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
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

describe('board store optimistic rollback', () => {
  // These instantiate their own store AFTER stubbing the api (the store captures
  // `useApi()` at setup), unlike the read-getter suite above.
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('moveBlock restores the pre-drag position when the API rejects', async () => {
    vi.stubGlobal('useApi', () => ({
      moveBlock: () => Promise.reject(new Error('conflict')),
    }))
    const store = useBoardStore()
    store.hydrate([frame('f1'), task('t1', 'f1', { position: { x: 10, y: 20 } })])
    await store.moveBlock('t1', { x: 500, y: 600 })
    expect(store.getBlock('t1')?.position).toEqual({ x: 10, y: 20 })
  })

  it('moveBlock keeps the new position on success', async () => {
    vi.stubGlobal('useApi', () => ({
      moveBlock: async () => task('t1', 'f1', { position: { x: 500, y: 600 } }),
    }))
    const store = useBoardStore()
    store.hydrate([frame('f1'), task('t1', 'f1', { position: { x: 10, y: 20 } })])
    await store.moveBlock('t1', { x: 500, y: 600 })
    expect(store.getBlock('t1')?.position).toEqual({ x: 500, y: 600 })
  })

  it('updateBlock restores only the patched fields when the API rejects', async () => {
    vi.stubGlobal('useApi', () => ({
      updateBlock: () => Promise.reject(new Error('validation')),
    }))
    const store = useBoardStore()
    store.hydrate([frame('f1'), task('t1', 'f1', { title: 'orig', description: 'keep' })])
    await store.updateBlock('t1', { title: 'renamed' })
    expect(store.getBlock('t1')?.title).toBe('orig')
    expect(store.getBlock('t1')?.description).toBe('keep')
  })

  it('reparentBlock offers an undo that moves the block back to its previous home', async () => {
    vi.stubGlobal('useApi', () => ({
      reparentBlock: async (
        _ws: string,
        id: string,
        body: { parentId: string; position: unknown },
      ) => task(id, body.parentId, { position: body.position as { x: number; y: number } }),
    }))
    interface ToastAction {
      onClick: () => void
    }
    const actions: ToastAction[] = []
    vi.stubGlobal('useToast', () => ({
      add: (t: { actions?: ToastAction[] }) => {
        if (t.actions) actions.push(...t.actions)
      },
    }))
    setActivePinia(createPinia())
    useWorkspaceStore().workspaceId = 'ws1'
    const store = useBoardStore()
    store.hydrate([
      frame('f1'),
      moduleBlock('m1', 'f1'),
      task('t1', 'f1', { position: { x: 1, y: 2 } }),
    ])
    await store.reparentBlock('t1', 'm1', { x: 5, y: 6 })
    expect(store.getBlock('t1')?.parentId).toBe('m1')
    // the undo action returns the block to its original parent + position
    expect(actions).toHaveLength(1)
    actions[0]!.onClick()
    await vi.waitFor(() => {
      expect(store.getBlock('t1')?.parentId).toBe('f1')
      expect(store.getBlock('t1')?.position).toEqual({ x: 1, y: 2 })
    })
    // the undo move is itself non-undoable, so no second toast is queued
    expect(actions).toHaveLength(1)
  })
})

describe('board store deferred delete + undo', () => {
  interface ToastAction {
    onClick: () => void
  }
  /** Build a store with a stubbed api/toast, capturing the undo action offered on delete. */
  function setup(removeImpl: () => Promise<void>) {
    const removeSpy = vi.fn(removeImpl)
    const addSpy = vi.fn()
    const actions: ToastAction[] = []
    vi.stubGlobal('useApi', () => ({ removeBlock: removeSpy }))
    vi.stubGlobal('useToast', () => ({
      add: (t: { actions?: ToastAction[] }) => {
        addSpy(t)
        if (t.actions) actions.push(...t.actions)
      },
    }))
    setActivePinia(createPinia())
    useWorkspaceStore().workspaceId = 'ws1'
    return { store: useBoardStore(), removeSpy, addSpy, actions }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hides the subtree immediately but defers the backend delete', () => {
    const { store, removeSpy } = setup(async () => {})
    store.hydrate([frame('f1'), moduleBlock('m1', 'f1'), task('t1', 'm1')])
    store.removeBlock('f1')
    // the whole subtree disappears at once…
    expect(store.getBlock('f1')).toBeUndefined()
    expect(store.getBlock('m1')).toBeUndefined()
    expect(store.getBlock('t1')).toBeUndefined()
    // …but nothing is deleted server-side yet.
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('keeps a pending-delete subtree hidden across a coarse refresh, and prunes its edges', () => {
    const { store } = setup(async () => {})
    store.hydrate([frame('f1'), task('t1', 'f1'), task('t2', 'f1', { dependsOn: ['t1'] })])
    store.removeBlock('t1')
    // A full re-hydrate (e.g. a `board` live event) that still carries the deleted block and
    // the now-dangling dependency edge must not resurrect either.
    store.hydrate([frame('f1'), task('t1', 'f1'), task('t2', 'f1', { dependsOn: ['t1'] })])
    expect(store.getBlock('t1')).toBeUndefined()
    expect(store.getBlock('t2')?.dependsOn).toEqual([])
  })

  it('ignores a live upsert for a block awaiting its deferred delete', () => {
    const { store } = setup(async () => {})
    store.hydrate([frame('f1'), task('t1', 'f1')])
    store.removeBlock('t1')
    store.upsert(task('t1', 'f1', { title: 'resurrected' }))
    expect(store.getBlock('t1')).toBeUndefined()
  })

  it('undo cancels the pending delete and restores the subtree', async () => {
    const { store, removeSpy, actions } = setup(async () => {})
    store.hydrate([frame('f1'), moduleBlock('m1', 'f1'), task('t1', 'm1')])
    store.removeBlock('f1')
    expect(actions).toHaveLength(1)
    actions[0]!.onClick()
    expect(store.getBlock('f1')?.id).toBe('f1')
    expect(store.getBlock('t1')?.id).toBe('t1')
    // the deferred delete never fires after an undo
    await vi.runAllTimersAsync()
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('fires the backend delete for the captured workspace once the window elapses', async () => {
    const { store, removeSpy } = setup(async () => {})
    store.hydrate([frame('f1')])
    store.removeBlock('f1')
    await vi.runAllTimersAsync()
    expect(removeSpy).toHaveBeenCalledWith('ws1', 'f1')
  })

  it('restores the subtree and toasts an error if the deferred delete fails', async () => {
    const { store, addSpy } = setup(() => Promise.reject(new Error('boom')))
    store.hydrate([frame('f1'), task('t1', 'f1')])
    store.removeBlock('f1')
    await vi.runAllTimersAsync()
    expect(store.getBlock('f1')?.id).toBe('f1')
    expect(store.getBlock('t1')?.id).toBe('t1')
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
  })
})
