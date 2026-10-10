import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLaneViewStore } from '~/stores/laneView'

// The preference is PERSISTED in the reader's browser, which makes the restored value
// untrusted input: a blob written by an older build can name a sort key this build has
// retired, and feeding that to the comparator lookup would throw mid-sort and take the whole
// board down over a stale preference. That narrowing is the thing worth pinning here.

describe('laneView store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('defaults to the per-lane smart order with no grouping', () => {
    const store = useLaneViewStore()
    expect(store.sortKey).toBe('smart')
    expect(store.groupKey).toBe('none')
    expect(store.hasOverride).toBe(false)
  })

  it('opens with the Done lane collapsed', () => {
    // A service with a long history would otherwise open as a wall of merged cards.
    expect(useLaneViewStore().doneLaneCollapsed).toBe(true)
  })

  it('falls back to the default when a restored key is not in this build vocabulary', () => {
    const store = useLaneViewStore()
    // Exactly what a persisted blob from an older build looks like.
    store.storedSortKey = 'sort_by_vibes'
    store.storedGroupKey = 'group_by_astrology'
    expect(store.sortKey).toBe('smart')
    expect(store.groupKey).toBe('none')
    // …and a stale value must not read as an override, or the board would claim a preference
    // it is not actually applying.
    expect(store.hasOverride).toBe(false)
  })

  it('reports an override so the control survives a switch to basic mode', () => {
    const store = useLaneViewStore()
    store.setSortKey('severity_desc')
    expect(store.hasOverride).toBe(true)
    store.reset()
    expect(store.hasOverride).toBe(false)
    expect(store.sortKey).toBe('smart')
  })

  it('treats grouping alone as an override', () => {
    const store = useLaneViewStore()
    store.setGroupKey('module')
    expect(store.hasOverride).toBe(true)
  })

  it('toggles the Done lane', () => {
    const store = useLaneViewStore()
    store.toggleDoneLane()
    expect(store.doneLaneCollapsed).toBe(false)
    store.toggleDoneLane()
    expect(store.doneLaneCollapsed).toBe(true)
  })
})
