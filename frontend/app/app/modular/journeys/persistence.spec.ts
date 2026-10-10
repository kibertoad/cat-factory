import { describe, expect, it } from 'vitest'
import type { SerializedJourney } from '@modular-vue/journeys'
import { catFactoryJourneyPersistence, useJourneyPersistenceStore } from './persistence'

// The Pinia-backed journey persistence adapter (slice 3). This is what makes a
// modal-hosted wizard RESUME on reopen: `keyFor` scopes the stored blob, `save`
// records it, `load` returns it (so `runtime.start()` rehydrates instead of
// minting fresh), and `remove` drops it on completion. A fresh Pinia is installed
// per test by `test/setup.ts`.

interface FrameInput {
  frameId: string | null
}

type FrameState = { frameId: string | null }

function blob(step: string): SerializedJourney<FrameState> {
  // Minimal plain-JSON blob — the adapter only stores/round-trips it (JSON clone),
  // it never interprets the shape, so a representative object suffices.
  return {
    journeyId: 'environment-setup',
    version: '1.0.0',
    state: { frameId: 'blk_1' },
    step,
  } as unknown as SerializedJourney<FrameState>
}

describe('catFactoryJourneyPersistence', () => {
  const persistence = catFactoryJourneyPersistence<FrameInput, { frameId: string | null }>(
    ({ journeyId, input }) => `${journeyId}:${input.frameId ?? 'new'}`,
  )

  it('derives a deterministic, frame-scoped key', () => {
    expect(
      persistence.keyFor({ journeyId: 'environment-setup', input: { frameId: 'blk_1' } }),
    ).toBe('environment-setup:blk_1')
    expect(persistence.keyFor({ journeyId: 'environment-setup', input: { frameId: null } })).toBe(
      'environment-setup:new',
    )
  })

  it('round-trips save → load and detaches the loaded blob from the store', () => {
    const key = 'environment-setup:blk_1'
    persistence.save(key, blob('review'))

    // Persisted under that key in the Pinia store.
    expect(useJourneyPersistenceStore().journeys[key]).toMatchObject({ step: 'review' })

    const loaded = persistence.load(key)
    expect(loaded).toMatchObject({ step: 'review', state: { frameId: 'blk_1' } })
    // Cloned, not the live store reference (mutating the load can't corrupt state).
    expect(loaded).not.toBe(useJourneyPersistenceStore().journeys[key])
  })

  it('returns null for an unknown key (a fresh start)', () => {
    expect(persistence.load('environment-setup:never-saved')).toBeNull()
  })

  it('removes a blob on completion so the next start is fresh', () => {
    const key = 'environment-setup:blk_9'
    persistence.save(key, blob('save'))
    expect(persistence.load(key)).not.toBeNull()

    persistence.remove(key)
    expect(persistence.load(key)).toBeNull()
    expect(useJourneyPersistenceStore().journeys[key]).toBeUndefined()
  })
})
