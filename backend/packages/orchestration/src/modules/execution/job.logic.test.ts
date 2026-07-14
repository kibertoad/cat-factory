import { ConflictError, harnessDispatchError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  classifyDispatchFailure,
  isContainerEvictionError,
  MAX_EVICTION_RECOVERIES,
  MAX_TRANSIENT_EVICTION_RECOVERIES,
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
})
