import { describe, expect, it } from 'vitest'
import {
  createBoardNodeProjection,
  frameZIndex,
  type BoardNodeSource,
} from '~/components/board/BoardCanvas.logic'

const NO_STACK = { draggingId: null, hoveredFrameId: null }

function at(id: string, x = 0, y = 0): BoardNodeSource {
  return { id, position: { x, y } }
}

describe('frameZIndex', () => {
  it('lifts the dragged frame above the hovered one, and both above the rest', () => {
    const stacking = { draggingId: 'dragged', hoveredFrameId: 'hovered' }
    expect(frameZIndex('dragged', stacking)).toBeGreaterThan(frameZIndex('hovered', stacking))
    expect(frameZIndex('hovered', stacking)).toBeGreaterThan(frameZIndex('other', stacking))
  })
})

describe('createBoardNodeProjection', () => {
  it('projects frames and epics with the fields the canvas binds', () => {
    const project = createBoardNodeProjection()
    const [frame, epic] = project([at('f1', 10, 20)], [at('e1', 30, 40)], NO_STACK)
    expect(frame).toMatchObject({
      id: 'f1',
      type: 'block',
      position: { x: 10, y: 20 },
      draggable: false,
      zIndex: 1,
    })
    expect(epic).toMatchObject({
      id: 'e1',
      type: 'epic',
      position: { x: 30, y: 40 },
      draggable: true,
    })
  })

  // The whole point of the memo: a hover changes two nodes, so it must allocate two nodes.
  it('reuses every node a hover did not change', () => {
    const project = createBoardNodeProjection()
    const frames = [at('a'), at('b'), at('c')]
    const before = project(frames, [], NO_STACK)
    const after = project(frames, [], { draggingId: null, hoveredFrameId: 'b' })

    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1])
    expect(after[1]!.zIndex).toBeGreaterThan(before[1]!.zIndex!)
  })

  it('rebuilds a node whose position moved', () => {
    const project = createBoardNodeProjection()
    const before = project([at('a', 0, 0)], [], NO_STACK)
    const after = project([at('a', 5, 0)], [], NO_STACK)
    expect(after[0]).not.toBe(before[0])
    expect(after[0]!.position).toEqual({ x: 5, y: 0 })
  })

  it('does not keep a removed frame alive in the memo', () => {
    const project = createBoardNodeProjection()
    const first = project([at('a'), at('b')], [], NO_STACK)
    project([at('b')], [], NO_STACK)
    // 'a' is gone from the cache, so its return is a fresh object rather than the stale one.
    const back = project([at('a'), at('b')], [], NO_STACK)
    expect(back[0]).not.toBe(first[0])
    expect(back.map((n) => n.id)).toEqual(['a', 'b'])
  })
})
