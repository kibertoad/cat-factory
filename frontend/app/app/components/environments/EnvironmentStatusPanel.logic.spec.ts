import { describe, it, expect } from 'vitest'
import { readStatusNote, showsProviderFailure } from './EnvironmentStatusPanel.logic'
import type { RunEnvironment } from '~/types/execution'

/**
 * The panel is where a person watches an environment come up, so it is also where the two prose
 * channels can be shown to contradict each other. The failure this pins is a fault going unshown:
 * a note is only ever context, and rendering it while `lastError` is suppressed reports a healthy
 * spin-up on a row that recorded a real problem.
 */
const env = (over: Partial<RunEnvironment>): RunEnvironment =>
  ({ id: 'env-1', url: null, status: 'provisioning', ...over }) as RunEnvironment

describe('readStatusNote', () => {
  it('shows what a still-provisioning environment is waiting on', () => {
    expect(readStatusNote(env({ statusNote: '  the deploy job is queued  ' }))).toBe(
      'the deploy job is queued',
    )
  })

  it('withholds the note whenever a fault is recorded, whatever the status', () => {
    // A teardown carries the row's `lastError` forward, so a failed-then-torn-down environment is
    // a real shape with both fields set and a status the error block does not cover. Keyed off
    // that block's own render condition, the panel showed the note and NO fault at all.
    expect(
      readStatusNote(
        env({ status: 'torn_down', lastError: 'quota exceeded', statusNote: 'still deploying' }),
      ),
    ).toBeNull()
    expect(
      readStatusNote(
        env({ status: 'failed', lastError: 'quota exceeded', statusNote: 'still deploying' }),
      ),
    ).toBeNull()
  })

  it('says nothing beside an environment that reached the state the note explains', () => {
    // "Provider note: the workload is not routed yet" beside a green READY badge is two claims,
    // and the badge is the true one.
    expect(readStatusNote(env({ status: 'ready', statusNote: 'not routed yet' }))).toBeNull()
    expect(readStatusNote(env({ status: 'torn_down', statusNote: 'still deploying' }))).toBeNull()
    expect(
      readStatusNote(env({ status: 'tearing_down', statusNote: 'still deploying' })),
    ).toBeNull()
  })

  it('keeps the note on a terminal status that recorded no fault', () => {
    // The same disposition kernel's readiness verdict takes: with no error to show, the last
    // thing the provider said is all there is.
    expect(
      readStatusNote(env({ status: 'failed', statusNote: 'the deploy job never started' })),
    ).toBe('the deploy job never started')
  })

  it('reads a blank note, an absent one and no environment alike', () => {
    expect(readStatusNote(env({ statusNote: '   ' }))).toBeNull()
    expect(readStatusNote(env({}))).toBeNull()
    expect(readStatusNote(null)).toBeNull()
  })
})

describe('showsProviderFailure', () => {
  it('is the fault block, on the statuses that stopped at one', () => {
    expect(showsProviderFailure(env({ status: 'failed', lastError: 'quota' }))).toBe(true)
    expect(showsProviderFailure(env({ status: 'expired', lastError: 'quota' }))).toBe(true)
    expect(showsProviderFailure(env({ status: 'provisioning', lastError: 'quota' }))).toBe(false)
    expect(showsProviderFailure(env({ status: 'failed' }))).toBe(false)
    expect(showsProviderFailure(null)).toBe(false)
  })
})
