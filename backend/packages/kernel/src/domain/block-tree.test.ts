import { describe, expect, it } from 'vitest'
import type { Block } from './types.js'
import {
  applicableFragmentIds,
  describeOwnService,
  resolveServiceFrameBlock,
} from './block-tree.js'

// `applicableFragmentIds` is the single source of truth every run-time fragment fold reads, so
// these pin the task-authoritative invariant the whole feature rests on: a task folds ONLY its own
// `fragmentIds` (a per-task removal sticks), while a frame folds its `serviceFragmentIds` too.
describe('applicableFragmentIds', () => {
  const frame = { level: 'frame', serviceFragmentIds: ['svc.a', 'svc.b'] } as unknown as Block

  it("folds only a task's own fragments (the frame's service set is NOT re-unioned)", () => {
    const task = { level: 'task', fragmentIds: ['task.x'] } as unknown as Block
    expect(applicableFragmentIds(task, frame)).toEqual(['task.x'])
  })

  it('resolves to nothing for a task that removed all of its inherited fragments', () => {
    const bareTask = { level: 'task', fragmentIds: undefined } as unknown as Block
    expect(applicableFragmentIds(bareTask, frame)).toEqual([])
  })

  it('does the same for a module (only a frame re-unions the service set)', () => {
    const mod = { level: 'module', fragmentIds: ['mod.y'] } as unknown as Block
    expect(applicableFragmentIds(mod, frame)).toEqual(['mod.y'])
  })

  it("folds the service standards then the frame's own pins for a FRAME-level run", () => {
    // A frame-level run resolves its own block as the service frame, so `serviceFrame === block`.
    const frameWithPins = {
      level: 'frame',
      serviceFragmentIds: ['svc.a', 'svc.b'],
      fragmentIds: ['svc.b', 'frame.own'],
    } as unknown as Block
    // Service standards first, then block pins, deduped (svc.b appears once).
    expect(applicableFragmentIds(frameWithPins, frameWithPins)).toEqual([
      'svc.a',
      'svc.b',
      'frame.own',
    ])
  })

  it('tolerates an absent service frame', () => {
    const task = { level: 'task', fragmentIds: ['task.x'] } as unknown as Block
    expect(applicableFragmentIds(task, null)).toEqual(['task.x'])
  })

  it('folds a FRAME-level run with no resolved service frame down to its own pins', () => {
    // A frame is the one level that reads the service set, so it is also the one level where an
    // absent frame has to be tolerated rather than dereferenced.
    const frameOnly = { level: 'frame', fragmentIds: ['frame.own'] } as unknown as Block
    expect(applicableFragmentIds(frameOnly, undefined)).toEqual(['frame.own'])
    expect(applicableFragmentIds(frameOnly, null)).toEqual(['frame.own'])
  })

  it('folds a frame whose service declares no standards down to its own pins', () => {
    const frameOnly = { level: 'frame', fragmentIds: ['frame.own'] } as unknown as Block
    expect(applicableFragmentIds(frameOnly, {} as unknown as Block)).toEqual(['frame.own'])
  })
})

// `describeOwnService` answers "what system is this work for?" for every prompt-assembling path.
// The distinction these pin is the whole point: a frame-level run has no OWNING service because it
// IS one (nothing to say), while a loose task has none because the platform does not know — and
// that second case has to be reported, or a model fills it in for itself.
describe('describeOwnService', () => {
  const task = { id: 'blk_task', level: 'task' } as unknown as Block
  const serviceFrame = {
    id: 'blk_frame',
    level: 'frame',
    title: 'billing-api',
    description: '  Bills customers.  ',
  } as unknown as Block

  it("names the task's enclosing service frame, trimming its description", () => {
    expect(describeOwnService(task, serviceFrame)).toEqual({
      stated: true,
      frameId: 'blk_frame',
      title: 'billing-api',
      description: 'Bills customers.',
    })
  })

  it('omits an empty service description rather than carrying a blank one', () => {
    const bare = { id: 'blk_frame', level: 'frame', title: 'api', description: '   ' }
    expect(describeOwnService(task, bare as unknown as Block)).toEqual({
      stated: true,
      frameId: 'blk_frame',
      title: 'api',
    })
  })

  it('states a service that carries no description at all', () => {
    const undescribed = { id: 'blk_frame', level: 'frame', title: 'api' }
    expect(describeOwnService(task, undescribed as unknown as Block)).toEqual({
      stated: true,
      frameId: 'blk_frame',
      title: 'api',
    })
  })

  it('reports "the block IS the service" for a frame-level run', () => {
    const frame = { id: 'blk_frame', level: 'frame', title: 'api' } as unknown as Block
    expect(describeOwnService(frame, frame)).toEqual({
      stated: false,
      reason: 'block-is-the-service',
    })
  })

  it('reports "not under a service" when the walk found no frame', () => {
    expect(describeOwnService(task, null)).toEqual({
      stated: false,
      reason: 'not-under-a-service',
    })
  })

  it('reports "not under a service" when the walk stopped on a NON-frame topmost block', () => {
    // `resolveServiceFrameBlock` returns the topmost block reached when the ancestry holds no
    // frame, so the level has to be re-checked here — a parentless module is not a service.
    const topmostModule = { id: 'blk_mod', level: 'module', title: 'loose module' }
    expect(describeOwnService(task, topmostModule as unknown as Block)).toEqual({
      stated: false,
      reason: 'not-under-a-service',
    })
  })

  it('reports "not under a service" when the walk resolved the block to itself', () => {
    const selfish = { id: 'blk_task', level: 'frame', title: 'x' } as unknown as Block
    expect(describeOwnService(task, selfish)).toEqual({
      stated: false,
      reason: 'not-under-a-service',
    })
  })
})

// The ancestry walk `describeOwnService` reads from, and the reason both the engine's context
// builder and the inline reviewers answer "which service is this?" the same way. What it returns
// on a chain with no frame in it is not an edge case: it is the input the caller above turns into
// the "not under a service" statement, so a walk that quietly returned null instead of the topmost
// block would swap one refusal for another that reads identically and is reached differently.
describe('resolveServiceFrameBlock', () => {
  type Node = Pick<Block, 'id' | 'level' | 'parentId'>

  /** A point-read over a fixed set of blocks, counting the reads so a skipped one is provable. */
  function tree(...nodes: Node[]) {
    const byId = new Map(nodes.map((n) => [n.id, n as Block]))
    const reads: string[] = []
    return {
      reads,
      get: async (blockId: string) => {
        reads.push(blockId)
        return byId.get(blockId) ?? null
      },
    }
  }

  const node = (id: string, level: Block['level'], parentId: string | null): Node =>
    ({ id, level, parentId }) as Node

  it('walks a task up through its module to the enclosing service frame', async () => {
    const { get, reads } = tree(
      node('task', 'task', 'mod'),
      node('mod', 'module', 'frame'),
      node('frame', 'frame', null),
    )
    expect(await resolveServiceFrameBlock(get, 'task')).toMatchObject({ id: 'frame' })
    expect(reads).toEqual(['task', 'mod', 'frame'])
  })

  it('begins from a caller-supplied start block, skipping the initial point-read', async () => {
    const { get, reads } = tree(node('mod', 'module', 'frame'), node('frame', 'frame', null))
    const start = node('task', 'task', 'mod') as Block
    expect(await resolveServiceFrameBlock(get, 'task', start)).toMatchObject({ id: 'frame' })
    expect(reads).toEqual(['mod', 'frame'])
  })

  it('point-reads the id when the caller passes a null start rather than trusting the null', async () => {
    // `start` is optional AND nullable, so a caller holding "I looked and found nothing" passes
    // null: that has to fall back to the read, not short-circuit the walk to nothing.
    const { get, reads } = tree(node('frame', 'frame', null))
    expect(await resolveServiceFrameBlock(get, 'frame', null)).toMatchObject({ id: 'frame' })
    expect(reads).toEqual(['frame'])
  })

  it('stops at a frame even when that frame has a parent of its own', async () => {
    // Frames cannot nest on the board, but the walk stops on the LEVEL rather than on running out
    // of ancestry, so a frame carrying a stale parentId still resolves to itself.
    const { get } = tree(
      node('task', 'task', 'frame'),
      node('frame', 'frame', 'stale'),
      node('stale', 'frame', null),
    )
    expect(await resolveServiceFrameBlock(get, 'task')).toMatchObject({ id: 'frame' })
  })

  it('returns the topmost block reached when the ancestry holds no frame', async () => {
    // NOT null: `describeOwnService` re-checks the level and turns this into "not under a
    // service", and the block it stopped on is what a caller logs when explaining why.
    const { get } = tree(node('task', 'task', 'mod'), node('mod', 'module', null))
    expect(await resolveServiceFrameBlock(get, 'task')).toMatchObject({ id: 'mod' })
  })

  it('returns null when the starting block is absent', async () => {
    const { get } = tree()
    expect(await resolveServiceFrameBlock(get, 'ghost')).toBeNull()
  })

  it('returns null when the chain points at a parent that no longer exists', async () => {
    const { get } = tree(node('task', 'task', 'deleted'))
    expect(await resolveServiceFrameBlock(get, 'task')).toBeNull()
  })

  it('gives up after 8 hops rather than looping on a cyclic parent chain', async () => {
    // The board is at most frame → module → task, so a chain deeper than that is corruption. The
    // bound is what stops it becoming a hang; the block it gives up on is returned as-is.
    const deep = Array.from({ length: 12 }, (_, i) =>
      node(`b${i}`, 'task', i === 11 ? null : `b${i + 1}`),
    )
    const { get, reads } = tree(...deep)
    // 8 iterations from b0: the 8th hop lands on b8, and the loop stops before testing it.
    expect(await resolveServiceFrameBlock(get, 'b0')).toMatchObject({ id: 'b8' })
    expect(reads).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'])
  })
})
