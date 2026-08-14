import { describe, it, expect } from 'vitest'
import { createLaneMemo } from '~/utils/laneIdentity'
import type { LaneGroup, LaneTaskEntry, RenderedLane } from '~/utils/laneSort'
import type { Block } from '~/types/domain'

const taskA = { id: 'a', title: 'A' } as unknown as Block
const taskB = { id: 'b', title: 'B' } as unknown as Block

function entry(task: Block, over: Partial<LaneTaskEntry> = {}): LaneTaskEntry {
  return {
    task,
    reason: 'running',
    order: 0,
    activityAt: null,
    waitingSince: null,
    moduleName: null,
    initiativeName: null,
    epicName: null,
    ...over,
  } as LaneTaskEntry
}

function group(id: string | null, entries: LaneTaskEntry[]): LaneGroup {
  return { id, label: id, entries }
}

function lanes(...groups: LaneGroup[][]): RenderedLane[] {
  const names = ['not_started', 'in_progress', 'needs_you', 'done'] as const
  return groups.map((g, i) => ({
    lane: names[i]!,
    groups: g,
    total: g.reduce((n, x) => n + x.entries.length, 0),
  }))
}

describe('lane structural sharing', () => {
  it('returns the previous array when nothing changed', () => {
    const share = createLaneMemo()
    const first = share(lanes([group('g1', [entry(taskA)])]))
    const second = share(lanes([group('g1', [entry(taskA)])]))
    expect(second).toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second[0]!.groups[0]).toBe(first[0]!.groups[0])
    expect(second[0]!.groups[0]!.entries[0]).toBe(first[0]!.groups[0]!.entries[0])
  })

  it('keeps the untouched lane identical while replacing the one that changed', () => {
    const share = createLaneMemo()
    const first = share(lanes([group('g1', [entry(taskA)])], [group('g2', [entry(taskB)])]))
    const second = share(
      lanes([group('g1', [entry(taskA)])], [group('g2', [entry(taskB, { activityAt: 5 })])]),
    )
    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
  })

  // Half of the reference rule: a REPLACED block (what every `board.upsert` does) is a new object,
  // so reuse cannot hand a renderer the pre-write one.
  it('does not reuse an entry whose task object was replaced', () => {
    const share = createLaneMemo()
    const first = share(lanes([group('g1', [entry(taskA)])]))
    const renamed = { id: 'a', title: 'A renamed' } as unknown as Block
    const second = share(lanes([group('g1', [entry(renamed)])]))
    expect(second).not.toBe(first)
    expect(second[0]!.groups[0]!.entries[0]!.task).toBe(renamed)
  })

  /**
   * The other half, and the case the comparison deliberately does NOT try to detect:
   * `stores/board/placement.ts` patches a block IN PLACE for its optimistic writes, so both entries
   * hold the same object and no comparison over it could see the difference. Reuse is still
   * observationally identical, because the object a renderer reads through IS the patched one (and
   * `board.blocks` is deeply reactive, so the patch invalidates whatever read it). What must not be
   * reused is an entry whose DERIVED fields moved with the patch, which is the assertion below.
   */
  it('reuses an entry whose task was patched in place, but not its derived fields', () => {
    const share = createLaneMemo()
    const task = { id: 'a', title: 'A', moduleName: null } as unknown as Block
    const first = share(lanes([group('g1', [entry(task)])]))
    Object.assign(task, { title: 'A patched', moduleName: 'billing' })
    // Same derived fields: the entry is reused, and it carries the patched object.
    const unchanged = share(lanes([group('g1', [entry(task)])]))
    expect(unchanged).toBe(first)
    expect(unchanged[0]!.groups[0]!.entries[0]!.task.title).toBe('A patched')
    // The assembly re-derived `moduleName` from the patch: that is a fresh entry.
    const rederived = share(lanes([group('g1', [entry(task, { moduleName: 'billing' })])]))
    expect(rederived).not.toBe(first)
    expect(rederived[0]!.groups[0]!.entries[0]!.moduleName).toBe('billing')
  })

  it('treats reordering, additions and removals as changes', () => {
    const share = createLaneMemo()
    const first = share(lanes([group('g1', [entry(taskA), entry(taskB)])]))
    expect(share(lanes([group('g1', [entry(taskB), entry(taskA)])]))).not.toBe(first)

    const share2 = createLaneMemo()
    const base = share2(lanes([group('g1', [entry(taskA)])]))
    expect(share2(lanes([group('g1', [entry(taskA), entry(taskB)])]))).not.toBe(base)
  })

  it('reuses an unchanged group while the sibling group in the same lane changes', () => {
    const share = createLaneMemo()
    const first = share(lanes([group('g1', [entry(taskA)]), group('g2', [entry(taskB)])]))
    const second = share(
      lanes([group('g1', [entry(taskA)]), group('g2', [entry(taskB, { order: 3 })])]),
    )
    expect(second[0]!.groups[0]).toBe(first[0]!.groups[0])
    expect(second[0]!.groups[1]).not.toBe(first[0]!.groups[1])
  })

  it('does not reuse a lane whose total changed even when its rendered groups match', () => {
    const share = createLaneMemo()
    const first = share(lanes([group('g1', [entry(taskA)])]))
    const capped = lanes([group('g1', [entry(taskA)])])
    capped[0] = { ...capped[0]!, total: 99 }
    expect(share(capped)).not.toBe(first)
  })
})
