import { ConflictError, harnessDispatchError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_PERSIST_THROTTLE_MS,
  classifyDispatchFailure,
  isContainerEvictionError,
  MAX_EVICTION_RECOVERIES,
  MAX_TRANSIENT_EVICTION_RECOVERIES,
  shouldPersistActivity,
} from './job.logic.js'

const CRASH_EVICTION = 'Job not found (container evicted or crashed)'

// `isContainerEvictionError` is the ONLY remaining eviction string test (error-message coverage
// I5): it classifies a DISPATCH-time eviction throw, which carries no job view to hold the
// structured `evicted` field. Poll-time eviction rides that field directly (see RunDispatcher /
// ContainerRepoBootstrapper / ContainerEnvConfigRepairer), so there is no string fallback to test.
describe('isContainerEvictionError (dispatch-time throw only)', () => {
  it('matches the eviction message', () => {
    expect(isContainerEvictionError(CRASH_EVICTION)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isContainerEvictionError('JOB NOT FOUND (CONTAINER EVICTED OR CRASHED)')).toBe(true)
  })

  it('does not match a genuine agent/job failure', () => {
    expect(isContainerEvictionError('Implementation failed: no file changes')).toBe(false)
    expect(isContainerEvictionError('Implementation job failed')).toBe(false)
  })

  it('handles an absent error', () => {
    expect(isContainerEvictionError(undefined)).toBe(false)
  })

  it('recovers a single crash eviction (budget of 1), transient a larger one', () => {
    expect(MAX_EVICTION_RECOVERIES).toBe(1)
    expect(MAX_TRANSIENT_EVICTION_RECOVERIES).toBeGreaterThan(MAX_EVICTION_RECOVERIES)
  })
})

describe('shouldPersistActivity (throttled liveness heartbeat)', () => {
  const base = 1_000_000_000_000

  it('persists the first heartbeat when none is stored yet', () => {
    expect(shouldPersistActivity(undefined, base)).toBe(true)
    expect(shouldPersistActivity(null, base)).toBe(true)
  })

  it('skips an advance smaller than the throttle window (avoids a write on every poll)', () => {
    expect(shouldPersistActivity(base, base + ACTIVITY_PERSIST_THROTTLE_MS - 1)).toBe(false)
    // A ~15s poll cadence is under the 20s window, so a single poll's advance is throttled out.
    expect(shouldPersistActivity(base, base + 15_000)).toBe(false)
  })

  it('persists once the heartbeat has advanced by at least the throttle window', () => {
    expect(shouldPersistActivity(base, base + ACTIVITY_PERSIST_THROTTLE_MS)).toBe(true)
    expect(shouldPersistActivity(base, base + 60_000)).toBe(true)
  })

  it('never persists a frozen (wedged) or absent heartbeat, so updated_at can go stale', () => {
    // A wedged job reports the SAME heartbeat every poll → never re-stamped → the sweeper/UI
    // correctly see the run as stale. This is the whole point of the signal.
    expect(shouldPersistActivity(base, base)).toBe(false)
    // A heartbeat that somehow went backwards is likewise not persisted.
    expect(shouldPersistActivity(base, base - 5_000)).toBe(false)
    // No incoming value (older harness image / transport that doesn't forward it) → no-op.
    expect(shouldPersistActivity(base, undefined)).toBe(false)
  })
})

describe('classifyDispatchFailure', () => {
  it('frames a domain PRECONDITION (ConflictError) as `preflight`, keeping its message + reason', () => {
    const err = new ConflictError(
      "No connected GitHub repository found for workspace 'ws1'. Connect it first.",
      'github_not_connected',
    )
    const c = classifyDispatchFailure(err)
    expect(c.failureKind).toBe('preflight')
    expect(c.reason).toBe('github_not_connected')
    // The actionable message survives (not replaced by the container framing) — on both fields.
    expect(c.error).toContain('No connected GitHub repository')
    expect(c.detail).toContain('No connected GitHub repository')
  })

  it('carries no reason for a domain error that has none', () => {
    const c = classifyDispatchFailure(new ConflictError('some conflict'))
    expect(c.failureKind).toBe('preflight')
    expect(c.reason).toBeUndefined()
  })

  it('routes a container eviction to `evicted` with the verbatim message', () => {
    const c = classifyDispatchFailure(new Error(CRASH_EVICTION))
    expect(c.failureKind).toBe('evicted')
    expect(c.error).toBe(CRASH_EVICTION)
    expect(c.reason).toBeUndefined()
  })

  it('frames a genuine container accept failure as `dispatch`, hiding the raw text behind detail', () => {
    const c = classifyDispatchFailure(new Error('HTTP 502 from runner'))
    expect(c.failureKind).toBe('dispatch')
    expect(c.error).toBe('The container failed to start.')
    expect(c.detail).toBe('HTTP 502 from runner')
    expect(c.reason).toBeUndefined()
  })

  it('surfaces a structured DispatchError message verbatim (incl. the 404 stale-image remedy)', () => {
    const c = classifyDispatchFailure(
      harnessDispatchError({ label: 'Container', status: 404, body: 'not found' }),
    )
    expect(c.failureKind).toBe('dispatch')
    // Not the generic "failed to start" — the elaborated remedy is the headline + the detail.
    expect(c.error).toContain('predates this dispatch route')
    expect(c.detail).toContain('predates this dispatch route')
    expect(c.reason).toBeUndefined()
  })

  // ADR 0026 D1: a generic throw on the FAILED recovery re-dispatch of an already-evicted step
  // (which had reached the agent phase and done work) must NOT read as "container failed to start".
  describe('a generic throw on a step that had already begun work (evicted-after-work)', () => {
    it('frames it as `evicted`, not a fresh-start `dispatch`', () => {
      const c = classifyDispatchFailure(new Error('HTTP 500 re-dispatch failed'), {
        evictionRecoveries: 1,
      })
      expect(c.failureKind).toBe('evicted')
      expect(c.error).not.toContain('failed to start')
      // The verbatim throw stays on `detail` for the post-mortem.
      expect(c.detail).toBe('HTTP 500 re-dispatch failed')
    })

    it('folds the elapsed minutes + partial slice count into the message', () => {
      const now = 1_000_000_000_000
      const c = classifyDispatchFailure(new Error('boom'), {
        evictionRecoveries: 1,
        startedAt: now - 17 * 60_000,
        sliceCount: 6,
        now,
      })
      expect(c.failureKind).toBe('evicted')
      expect(c.error).toContain('17 minutes of work')
      expect(c.error).toContain('6 slices reviewed')
      expect(c.error).toContain('could not be recovered')
    })

    it('reads cleanly with no timing/slice history (singular minute, no slice clause)', () => {
      const now = 1_000_000_000_000
      const c = classifyDispatchFailure(new Error('boom'), {
        transientEvictionRecoveries: 2,
        startedAt: now - 60_000,
        now,
      })
      expect(c.error).toBe(
        'The container was evicted after 1 minute of work and could not be recovered.',
      )
    })

    it('still frames a first-dispatch throw (no recoveries, no history) as `dispatch`', () => {
      const c = classifyDispatchFailure(new Error('HTTP 502 from runner'))
      expect(c.failureKind).toBe('dispatch')
      expect(c.error).toBe('The container failed to start.')
    })

    // A structured DispatchError keeps its `dispatch` framing even on a recovery re-dispatch: its
    // elaborated, actionable message (the raw status line + any stale-image remedy) is more useful
    // than — and not as misleading as — the generic eviction message. Precedence is deliberate.
    it('keeps a structured DispatchError as `dispatch` even after work had begun', () => {
      const c = classifyDispatchFailure(
        harnessDispatchError({ label: 'Container', status: 404, body: 'not found' }),
        { evictionRecoveries: 1, startedAt: 1_000_000_000_000 - 17 * 60_000, sliceCount: 6 },
      )
      expect(c.failureKind).toBe('dispatch')
      // The elaborated remedy is surfaced, NOT the generic "evicted after N minutes" message.
      expect(c.error).toContain('predates this dispatch route')
      expect(c.error).not.toContain('minutes of work')
    })
  })
})
