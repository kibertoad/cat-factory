import { describe, it, expect, beforeEach } from 'vitest'
import { useNotificationsStore } from '~/stores/notifications'
import type { Notification } from '~/types/domain'

/**
 * The live-write map is what stops a lagging refresh clobbering a card that arrived while its
 * snapshot was in flight. `hydrate` forgets whatever a snapshot has reconciled, which is what
 * bounds it, so the case that needed a second bound is a long stream period with NO refresh in it.
 */
function card(id: string): Notification {
  return {
    id,
    workspaceId: 'ws1',
    blockId: 'blk1',
    kind: 'review_wait',
    status: 'open',
    title: id,
    body: '',
    createdAt: 1,
  } as unknown as Notification
}

describe('notifications live-write map', () => {
  let store: ReturnType<typeof useNotificationsStore>
  beforeEach(() => {
    store = useNotificationsStore()
  })

  it('keeps the newest in-flight writes and forgets the oldest past the bound', () => {
    for (let i = 0; i < 250; i++) store.upsert(card(`n${i}`))
    // A refresh whose snapshot predates every one of those writes: what it re-inserts is exactly
    // what the map still remembers.
    store.hydrate([], 0)
    const kept = store.open.map((n) => n.id)
    expect(kept).toHaveLength(200)
    expect(kept).toContain('n249')
    expect(kept).not.toContain('n0')
  })

  it('still protects a write the in-flight refresh could not have seen', () => {
    const baseline = store.hydrateBaseline()
    store.upsert(card('live'))
    store.hydrate([], baseline)
    expect(store.open.map((n) => n.id)).toEqual(['live'])
  })
})
