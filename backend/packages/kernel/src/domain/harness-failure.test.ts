import { describe, expect, it } from 'vitest'
import {
  failureKindFromHarnessCause,
  HARNESS_FAILURE_CAUSES,
  isHarnessFailureCause,
} from './harness-failure.js'

describe('failureKindFromHarnessCause', () => {
  it('maps the watchdog timeouts to `timeout`', () => {
    expect(failureKindFromHarnessCause('inactivity-timeout')).toBe('timeout')
    expect(failureKindFromHarnessCause('max-duration')).toBe('timeout')
  })

  it('maps every other harness cause to `agent`', () => {
    for (const cause of ['agent', 'git', 'api', 'no-usable-output', 'no-changes', 'deploy']) {
      expect(failureKindFromHarnessCause(cause)).toBe('agent')
    }
  })

  it('classifies EVERY member of the union (no cause falls through to undefined)', () => {
    for (const cause of HARNESS_FAILURE_CAUSES) {
      expect(failureKindFromHarnessCause(cause)).toBeDefined()
    }
  })

  it('returns undefined for an absent/unknown cause (caller falls back to the error regex)', () => {
    expect(failureKindFromHarnessCause(undefined)).toBeUndefined()
    expect(failureKindFromHarnessCause('something-new')).toBeUndefined()
    // Eviction is never a harness cause — it rides `RunnerJobView.evicted` / the transport's
    // "(container evicted or crashed)" error string, not here.
    expect(failureKindFromHarnessCause('evicted')).toBeUndefined()
  })
})

describe('isHarnessFailureCause', () => {
  it('accepts every union member and rejects everything else', () => {
    for (const cause of HARNESS_FAILURE_CAUSES) {
      expect(isHarnessFailureCause(cause)).toBe(true)
    }
    expect(isHarnessFailureCause('evicted')).toBe(false)
    expect(isHarnessFailureCause('')).toBe(false)
    expect(isHarnessFailureCause(undefined)).toBe(false)
    expect(isHarnessFailureCause(42)).toBe(false)
  })
})
