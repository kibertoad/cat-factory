import { describe, expect, it } from 'vitest'
import {
  isContainerEvictionError,
  isTransientEviction,
  MAX_EVICTION_RECOVERIES,
  MAX_TRANSIENT_EVICTION_RECOVERIES,
  TRANSIENT_EVICTION_MARKER,
} from './job.logic.js'

const CRASH_EVICTION = 'Job not found (container evicted or crashed)'
const TRANSIENT_EVICTION = `${CRASH_EVICTION} (${TRANSIENT_EVICTION_MARKER})`

describe('isContainerEvictionError', () => {
  it('matches the transport 404 eviction message', () => {
    expect(isContainerEvictionError(CRASH_EVICTION)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isContainerEvictionError('JOB NOT FOUND (CONTAINER EVICTED OR CRASHED)')).toBe(true)
  })

  it('also matches a transient eviction (so the shared recovery machinery engages)', () => {
    expect(isContainerEvictionError(TRANSIENT_EVICTION)).toBe(true)
  })

  it('does not match a genuine agent/job failure', () => {
    expect(isContainerEvictionError('Implementation failed: no file changes')).toBe(false)
    expect(isContainerEvictionError('Implementation job failed')).toBe(false)
  })

  it('handles an absent error', () => {
    expect(isContainerEvictionError(undefined)).toBe(false)
  })

  it('recovers a single crash eviction (budget of 1)', () => {
    expect(MAX_EVICTION_RECOVERIES).toBe(1)
  })
})

describe('isTransientEviction', () => {
  it('matches a facade-tagged transient eviction', () => {
    expect(isTransientEviction(TRANSIENT_EVICTION)).toBe(true)
  })

  it('does not match a plain crash/OOM eviction', () => {
    expect(isTransientEviction(CRASH_EVICTION)).toBe(false)
  })

  it('handles an absent error', () => {
    expect(isTransientEviction(undefined)).toBe(false)
  })

  it('gives a transient eviction a larger recovery budget than a crash', () => {
    expect(MAX_TRANSIENT_EVICTION_RECOVERIES).toBeGreaterThan(MAX_EVICTION_RECOVERIES)
  })
})
