import { describe, it, expect } from 'vitest'
import { readEnvironmentAgainstClock } from './OutcomeSummaryWindow.logic'
import type { OutcomeEnvironment } from '~/utils/runOutcome'

/**
 * The one thing the outcome card decides for itself: whether the TTL the payload carries has
 * lapsed, and what that changes. The reduction behind the card is clock-free on purpose, so this
 * is the only place a reader is told an environment is past its expiry, and the failure it
 * guards is the section's worst one: a green "Live" badge and a working-looking button on a row
 * whose own expiry date is in the past.
 */
const NOW = 1_700_000_000_000

const env = (overrides: Partial<OutcomeEnvironment> = {}): OutcomeEnvironment => ({
  url: 'https://preview.test',
  state: 'live',
  origin: 'deployer',
  expiresAt: null,
  retained: false,
  frameId: 'frm_own',
  environmentId: 'env_1',
  detail: null,
  detailKind: null,
  ...overrides,
})

describe('readEnvironmentAgainstClock', () => {
  it('offers a live environment whose TTL has not lapsed', () => {
    const row = readEnvironmentAgainstClock(env({ expiresAt: NOW + 60_000 }), NOW)
    expect(row).toMatchObject({ state: 'live', lapsed: false, openable: true })
  })

  it('withholds the link once the TTL has lapsed, and says the environment expired', () => {
    const row = readEnvironmentAgainstClock(env({ expiresAt: NOW - 1 }), NOW)
    expect(row).toMatchObject({ state: 'expired', lapsed: true, openable: false })
    // The URL survives the lapse: it is what names the environment and what an operator greps.
    expect(row.url).toBe('https://preview.test')
  })

  // A run with no disposer and no further polls keeps a `provisioning` row forever, and one
  // whose TTL then lapsed never came up and never will.
  it('applies the lapse to an environment still coming up', () => {
    const row = readEnvironmentAgainstClock(env({ state: 'provisioning', expiresAt: NOW - 1 }), NOW)
    expect(row).toMatchObject({ state: 'expired', lapsed: true, openable: false })
  })

  // The clock may only answer the question the payload left open. Where a producer already said
  // WHERE the environment went, that word is the more specific one and it stands.
  it('never overwrites a state that already names where the environment went', () => {
    for (const state of ['failed', 'reclaimed', 'reclaiming'] as const) {
      const row = readEnvironmentAgainstClock(env({ state, expiresAt: NOW - 1 }), NOW)
      expect(row).toMatchObject({ state, lapsed: false, openable: false })
    }
  })

  // `useNowTick` reads 0 until the card mounts, and every instant in history is "past" the epoch.
  it('makes no clock-derived claim before the card has a clock', () => {
    const row = readEnvironmentAgainstClock(env({ expiresAt: NOW - 1 }), 0)
    expect(row).toMatchObject({ state: 'live', lapsed: false, openable: true })
  })

  it('offers nothing to click for a live environment that has no URL yet', () => {
    const row = readEnvironmentAgainstClock(env({ url: null }), NOW)
    expect(row).toMatchObject({ state: 'live', openable: false })
  })

  // A run that recorded no TTL is not an expired one: absent and lapsed are opposite facts.
  it('leaves a row carrying no TTL exactly as the payload states it', () => {
    expect(readEnvironmentAgainstClock(env(), NOW)).toMatchObject({
      state: 'live',
      lapsed: false,
      openable: true,
    })
  })
})
