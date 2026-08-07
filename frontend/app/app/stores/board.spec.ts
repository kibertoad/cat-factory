import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { Block, BlockStatus } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useWorkspaceStore } from '~/stores/workspace'
import { EMPTY_FRAME_SIZE } from '~/utils/framePlacement'
import { frameContentSize, laneBodyHeightIn, LANE_GEOMETRY } from '~/utils/laneGeometry'

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
const initiativeBlock = (id: string, parentId: string, over: Partial<Block> = {}) =>
  block(id, { level: 'initiative', parentId, ...over })

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
    // A frame's size is now a function of the LANE GEOMETRY, not of its contents. That is the
    // point of the swimlanes: each lane scrolls, so a service accumulating work no longer grows
    // a taller and taller frame until it dwarfs its neighbours. These tests pin the INVARIANT
    // (size independent of task count and task position) rather than the pixel arithmetic, which
    // belongs to `LANE_GEOMETRY` and would otherwise be restated here to no purpose.
    it('sizes a service with nothing in it to the panel it actually renders', () => {
      // An empty service shows one "add the first task" panel, not lanes, so it reserves the
      // panel's footprint. Reserving the lanes' would leave the frame more than twice as tall as
      // its own contents — and, since a placement clears frames by their reserved size, would
      // push its neighbours that much further away for a frame holding nothing.
      store.hydrate([frame('f1')])
      expect(store.containerSize('f1')).toEqual(
        frameContentSize({ hasChildren: false, initiatives: 0 }),
      )
    })

    it('reserves the same footprint for a new frame that a new frame will render at', () => {
      // The drift this caught: `EMPTY_FRAME_SIZE` is what a placement decision reserves BEFORE the
      // block exists, so it cannot measure the frame and has to predict it. A hand-copied pair
      // went stale when the floor changed underneath it, and every new service was then dropped
      // on top of a neighbour it had been placed to clear.
      store.hydrate([frame('f1')])
      expect(store.containerSize('f1')).toEqual(EMPTY_FRAME_SIZE)
    })

    it('does not grow with task count, however many tasks and wherever they sat', () => {
      store.hydrate([frame('f1'), task('t1', 'f1')])
      const oneTask = store.containerSize('f1')

      store.hydrate([
        frame('f1'),
        moduleBlock('m1', 'f1', { position: { x: 400, y: 300 } }),
        task('t1', 'm1', { position: { x: 300, y: 200 } }),
        // A position far outside the old content extent: it used to stretch the frame to reach
        // it, and now means nothing at all, because a task no longer renders at coordinates.
        task('t2', 'f1', { position: { x: 4000, y: 9000 } }),
      ])
      expect(store.containerSize('f1')).toEqual(oneTask)
    })

    it('makes room for the initiative band above the lanes', () => {
      // Initiatives are the one child still laid out by the frame itself (in a wrapping band),
      // so they are the one thing the frame's height still has to account for.
      store.hydrate([frame('f1'), task('t1', 'f1')])
      const withoutBand = store.containerSize('f1').h
      store.hydrate([frame('f1'), task('t1', 'f1'), initiativeBlock('i1', 'f1')])
      expect(store.containerSize('f1').h).toBe(withoutBand + LANE_GEOMETRY.initiativeHeight)
    })

    it('sizes a frame holding only an initiative for lanes, since that is what it renders', () => {
      // `BlockNode` gates the lanes on having ANY child — tasks, modules or initiatives — so a
      // frame with an initiative and no tasks renders three (empty) lanes. A size that disagreed
      // with what rendered is the clipping this geometry exists to prevent.
      store.hydrate([frame('f1'), initiativeBlock('i1', 'f1')])
      expect(store.containerSize('f1')).toEqual(
        frameContentSize({ hasChildren: true, initiatives: 1 }),
      )
    })

    it('a module reports no canvas of its own, since it is no longer drawn as a box', () => {
      store.hydrate([frame('f1'), moduleBlock('m1', 'f1'), task('t1', 'm1')])
      expect(store.containerSize('m1').h).toBe(0)
    })

    it('keeps an explicitly resized frame at the size the user dragged it to', () => {
      // The geometry is a FLOOR, not a fixed size: dragging the border still gives a reader more
      // room, and a lane grows its scroll viewport into it rather than leaving dead canvas below.
      store.hydrate([frame('f1', { size: { w: 2000, h: 1500 } }), task('t1', 'f1')])
      const size = store.containerSize('f1')
      expect(size).toEqual({ w: 2000, h: 1500 })
      expect(laneBodyHeightIn(size, 0)).toBeGreaterThan(LANE_GEOMETRY.laneBodyHeight)
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

  it('previewResize translates the children when the drag moves the content origin', () => {
    // A child's position is relative to its container's content origin, so growing the frame
    // 40px west (origin -40) has to move every direct child +40 or the whole content slides with
    // the border. A grandchild rides its module and must NOT move on its own.
    const store = useBoardStore()
    store.hydrate([
      frame('f1', { position: { x: 100, y: 100 }, size: { w: 600, h: 400 } }),
      moduleBlock('m1', 'f1', { position: { x: 20, y: 30 } }),
      task('t1', 'f1', { position: { x: 10, y: 20 } }),
      task('t2', 'm1', { position: { x: 5, y: 5 } }),
    ])
    store.previewResize('f1', { x: 60, y: 100 }, { w: 640, h: 400 })
    expect(store.getBlock('t1')?.position).toEqual({ x: 50, y: 20 })
    expect(store.getBlock('m1')?.position).toEqual({ x: 60, y: 30 })
    expect(store.getBlock('t2')?.position).toEqual({ x: 5, y: 5 })
  })

  it('previewResize leaves the children alone when only the far border moved', () => {
    const store = useBoardStore()
    store.hydrate([
      frame('f1', { position: { x: 100, y: 100 }, size: { w: 600, h: 400 } }),
      task('t1', 'f1', { position: { x: 10, y: 20 } }),
    ])
    store.previewResize('f1', { x: 100, y: 100 }, { w: 700, h: 500 })
    expect(store.getBlock('t1')?.position).toEqual({ x: 10, y: 20 })
    expect(store.getBlock('f1')?.size).toEqual({ w: 700, h: 500 })
  })

  it('resizeBlock rolls the bounds AND the child translation back when the API rejects', async () => {
    // The rollback has to undo both halves: a restored box with its contents still offset is the
    // one failure mode that looks fine until the next refresh moves everything.
    vi.stubGlobal('useApi', () => ({
      resizeBlock: () => Promise.reject(new Error('conflict')),
    }))
    setActivePinia(createPinia())
    useWorkspaceStore().workspaceId = 'ws1'
    const store = useBoardStore()
    store.hydrate([
      frame('f1', { position: { x: 100, y: 100 }, size: { w: 600, h: 400 } }),
      task('t1', 'f1', { position: { x: 10, y: 20 } }),
    ])
    await store.resizeBlock(
      'f1',
      { position: { x: 60, y: 70 }, size: { w: 640, h: 430 } },
      { position: { x: 100, y: 100 }, size: { w: 600, h: 400 } },
    )
    expect(store.getBlock('f1')?.position).toEqual({ x: 100, y: 100 })
    expect(store.getBlock('f1')?.size).toEqual({ w: 600, h: 400 })
    expect(store.getBlock('t1')?.position).toEqual({ x: 10, y: 20 })
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

  it('reparentBlock predicts the declared module the server will re-stamp', async () => {
    // The board reads a task's PARENT for its module and falls back to the name it DECLARES (a
    // task can name a module before the engine materialises the block on merge). So a card
    // dragged out of a module and left still declaring it re-groups under the module it was just
    // dragged out of. The server re-stamps the name on every reparent; the optimistic write here
    // has to predict the same answer or the card visibly jumps when the response lands.
    //
    // The request never settles, so what is asserted is strictly what this store put on screen
    // BEFORE hearing back — the window the card would otherwise spend in the wrong group.
    vi.stubGlobal('useApi', () => ({ reparentBlock: () => new Promise(() => {}) }))
    vi.stubGlobal('useToast', () => ({ add: () => {} }))
    setActivePinia(createPinia())
    useWorkspaceStore().workspaceId = 'ws1'
    const store = useBoardStore()
    store.hydrate([
      frame('f1'),
      moduleBlock('m1', 'f1', { title: 'Sessions' }),
      task('t1', 'm1', { moduleName: 'Sessions' }),
      task('t2', 'f1'),
    ])

    // Out to the service frame: the declared name goes with it, as the empty string the store
    // maps to NULL. Left behind, it is what files the card straight back into "Sessions".
    void store.reparentBlock('t1', 'f1', { x: 0, y: 0 })
    expect(store.getBlock('t1')?.moduleName).toBe('')

    // And in: the destination module's title, whatever the task declared before.
    void store.reparentBlock('t2', 'm1', { x: 0, y: 0 })
    expect(store.getBlock('t2')?.moduleName).toBe('Sessions')
  })

  it('reparentBlock restores the declared module when the move is rejected', async () => {
    // The same rollback contract the parent and position already had: a refused move must not
    // leave the card grouped somewhere the server never put it.
    vi.stubGlobal('useApi', () => ({
      reparentBlock: async () => {
        throw new Error('nope')
      },
    }))
    vi.stubGlobal('useToast', () => ({ add: () => {} }))
    setActivePinia(createPinia())
    useWorkspaceStore().workspaceId = 'ws1'
    const store = useBoardStore()
    store.hydrate([
      frame('f1'),
      moduleBlock('m1', 'f1', { title: 'Sessions' }),
      task('t1', 'm1', { moduleName: 'Sessions' }),
    ])

    await store.reparentBlock('t1', 'f1', { x: 0, y: 0 })
    expect(store.getBlock('t1')).toMatchObject({ parentId: 'm1', moduleName: 'Sessions' })
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

  it('does not reattach a failed deferred delete onto a different workspace', async () => {
    const { store } = setup(() => Promise.reject(new Error('boom')))
    store.hydrate([frame('f1'), task('t1', 'f1')])
    store.removeBlock('f1')
    // The user switches workspace during the undo window; when the delete then fails, the
    // ws1 subtree must NOT be injected onto the ws2 board now on screen.
    useWorkspaceStore().workspaceId = 'ws2'
    await vi.runAllTimersAsync()
    expect(store.getBlock('f1')).toBeUndefined()
    expect(store.getBlock('t1')).toBeUndefined()
  })

  it('runs onCommit with the captured workspace only when the window elapses', async () => {
    const { store } = setup(async () => {})
    const onCommit = vi.fn(async () => {})
    store.hydrate([frame('f1')])
    store.removeBlock('f1', { onCommit })
    await vi.runAllTimersAsync()
    expect(onCommit).toHaveBeenCalledWith('ws1')
  })

  it('skips onCommit (the irreversible side effect) when the delete is undone', async () => {
    const { store, actions } = setup(async () => {})
    const onCommit = vi.fn(async () => {})
    store.hydrate([frame('f1')])
    store.removeBlock('f1', { onCommit })
    actions[0]!.onClick() // undo before the window elapses
    await vi.runAllTimersAsync()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('undo re-adds pruned edges without clobbering ones gained during the window', () => {
    const { store, actions } = setup(async () => {})
    store.hydrate([
      frame('f1'),
      task('t1', 'f1'),
      task('t2', 'f1', { dependsOn: ['t1'] }),
      task('t3', 'f1'),
    ])
    store.removeBlock('t1')
    // A live event adds a new dependency to the survivor mid-window (t1's edge was pruned).
    store.upsert(task('t2', 'f1', { dependsOn: ['t3'] }))
    actions[0]!.onClick() // undo restores t1 and its edge, keeping the newly-added t3 edge
    expect(store.getBlock('t2')?.dependsOn.slice().sort()).toEqual(['t1', 't3'])
  })
})
