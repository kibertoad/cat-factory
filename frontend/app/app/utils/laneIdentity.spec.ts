import { describe, it, expect } from 'vitest'
import { createLaneMemo } from '~/utils/laneIdentity'
import type { LaneGroup, LaneTaskEntry } from '~/utils/laneSort'
import type { RenderedLane } from '~/composables/useFrameLanes'
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

  // The rule that makes reuse sound: a changed task is a changed OBJECT (the board store replaces
  // a block on every write), so identity on `task` is what covers the whole Block behind it.
  it('does not reuse an entry whose task object was replaced', () => {
    const share = createLaneMemo()
    const first = share(lanes([group('g1', [entry(taskA)])]))
    const renamed = { id: 'a', title: 'A renamed' } as unknown as Block
    const second = share(lanes([group('g1', [entry(renamed)])]))
    expect(second).not.toBe(first)
    expect(second[0]!.groups[0]!.entries[0]!.task).toBe(renamed)
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
