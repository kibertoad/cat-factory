import { describe, expect, it } from 'vitest'
import type { Block } from './types.js'
import { applicableFragmentIds, describeOwnService } from './block-tree.js'

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
