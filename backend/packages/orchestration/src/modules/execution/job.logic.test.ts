import { describe, expect, it } from 'vitest'
import { isContainerEvictionError, MAX_EVICTION_RECOVERIES } from './job.logic.js'

describe('isContainerEvictionError', () => {
  it('matches the transport 404 eviction message', () => {
    expect(isContainerEvictionError('Job not found (container evicted or crashed)')).toBe(true)
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

  it('recovers a single eviction (budget of 1)', () => {
    expect(MAX_EVICTION_RECOVERIES).toBe(1)
  })
})
