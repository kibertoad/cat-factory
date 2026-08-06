import { describe, expect, it } from 'vitest'
import type { Block, WorkspaceMount } from './types.js'
import { applyMountLayout, deliverableBoardBlock } from './mount-layout.js'

function frame(over: Partial<Block> = {}): Block {
  return {
    id: 'frame_1',
    title: 'web',
    type: 'service',
    description: '',
    // The coordinates the row was CREATED with — never updated once the frame is mounted.
    position: { x: 10, y: 20 },
    status: 'ready',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
    ...over,
  } as Block
}

function mount(over: Partial<WorkspaceMount> = {}): WorkspaceMount {
  return {
    workspaceId: 'ws_1',
    serviceId: 'svc_1',
    position: { x: 400, y: 300 },
    size: null,
    createdAt: 0,
    ...over,
  }
}

describe('applyMountLayout', () => {
  it('places the frame where THIS board mounts it, not where the shared row sits', () => {
    expect(applyMountLayout(frame(), mount()).position).toEqual({ x: 400, y: 300 })
  })

  it('leaves the block alone when there is no mount (non-frame / legacy / sharing unwired)', () => {
    const block = frame()
    expect(applyMountLayout(block, null)).toBe(block)
    expect(applyMountLayout(block, undefined)).toBe(block)
  })

  it('does not mutate the block it projects', () => {
    const block = frame()
    applyMountLayout(block, mount())
    expect(block.position).toEqual({ x: 10, y: 20 })
  })

  it('keeps the block size when the mount carries no size override', () => {
    expect(applyMountLayout(frame({ size: { w: 640, h: 480 } }), mount()).size).toEqual({
      w: 640,
      h: 480,
    })
  })

  it('applies the mount size override over the block size', () => {
    const projected = applyMountLayout(
      frame({ size: { w: 640, h: 480 } }),
      mount({ size: { w: 900, h: 700 } }),
    )
    expect(projected.size).toEqual({ w: 900, h: 700 })
  })
})

describe('deliverableBoardBlock', () => {
  it('refuses to carry a service frame', () => {
    // The failure this prevents is silent: one payload is published for every board a shared
    // service is mounted on, so a frame carrying the origin's coordinates would land on the
    // others and jump the frame to a spot none of them shows it at. Exactly what
    // `applyMountLayout` exists to stop, arriving by a different door.
    expect(deliverableBoardBlock(frame())).toBeNull()
  })

  it('treats a block with no explicit level as a frame', () => {
    // `level` is optional on the wire and the board reads an absent one as `frame`
    // (`useBlockQueries`). Defaulting the other way here would carry exactly the payload the
    // rule above refuses.
    expect(deliverableBoardBlock(frame({ level: undefined }))).toBeNull()
  })

  it('carries every level whose geometry lives on the shared row', () => {
    for (const level of ['task', 'module', 'epic', 'initiative'] as const) {
      const block = frame({ level, parentId: 'frame_1' })
      expect(deliverableBoardBlock(block), `${level} should be deliverable`).toBe(block)
    }
  })

  it('answers null for an absent block', () => {
    expect(deliverableBoardBlock(null)).toBeNull()
    expect(deliverableBoardBlock(undefined)).toBeNull()
  })
})
