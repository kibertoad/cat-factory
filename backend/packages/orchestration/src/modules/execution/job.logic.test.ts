import { ConflictError, harnessDispatchError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  classifyAgentFailure,
  classifyDispatchFailure,
  evictionKindOf,
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

describe('evictionKindOf', () => {
  it('prefers the transport STRUCTURED field over the error string', () => {
    // Field wins even when the error string says otherwise (a crash string tagged transient, etc.).
    expect(evictionKindOf('transient', CRASH_EVICTION)).toBe('transient')
    expect(evictionKindOf('crash', TRANSIENT_EVICTION)).toBe('crash')
    // …and even when there is no eviction string at all (the field is authoritative).
    expect(evictionKindOf('crash', 'Implementation job failed')).toBe('crash')
    expect(evictionKindOf('transient', undefined)).toBe('transient')
  })

  it('falls back to the error-string sentinels when no field is present (older producer)', () => {
    expect(evictionKindOf(undefined, CRASH_EVICTION)).toBe('crash')
    expect(evictionKindOf(undefined, TRANSIENT_EVICTION)).toBe('transient')
  })

  it('returns undefined when the failure is not an eviction (no field, no sentinel)', () => {
    expect(evictionKindOf(undefined, 'Implementation failed: no file changes')).toBeUndefined()
    expect(evictionKindOf(undefined, undefined)).toBeUndefined()
  })
})

// The structured cause → failure-kind mapping is the kernel's shared `failureKindFromHarnessCause`
// (tested in `kernel/src/domain/harness-failure.test.ts`); only the error-string fallback is
// engine-local.
describe('classifyAgentFailure (error-string fallback)', () => {
  it('maps the watchdog phrases to `timeout`, matching the bootstrap path', () => {
    expect(classifyAgentFailure('Aborted: no agent activity for 600s (likely hung)')).toBe(
      'timeout',
    )
    expect(classifyAgentFailure('Aborted: exceeded max duration of 3600s')).toBe('timeout')
    expect(classifyAgentFailure('inactivity watchdog fired')).toBe('timeout')
  })

  it('maps anything else (and an absent error) to `agent`', () => {
    expect(classifyAgentFailure('the agent produced no usable result')).toBe('agent')
    expect(classifyAgentFailure(undefined)).toBe('agent')
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
