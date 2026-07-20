import { describe, expect, it } from 'vitest'
import type { Block } from './types.js'
import { applicableFragmentIds } from './block-tree.js'

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
