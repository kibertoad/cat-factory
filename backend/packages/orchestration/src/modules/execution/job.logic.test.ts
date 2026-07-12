import { ConflictError, harnessDispatchError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  agentFailureKindFromCause,
  classifyAgentFailure,
  classifyDispatchFailure,
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

describe('agentFailureKindFromCause', () => {
  it('maps the watchdog timeouts to `timeout`', () => {
    expect(agentFailureKindFromCause('inactivity-timeout')).toBe('timeout')
    expect(agentFailureKindFromCause('max-duration')).toBe('timeout')
  })

  it('maps every other harness cause to `agent`', () => {
    for (const cause of ['agent', 'git', 'api', 'no-usable-output', 'no-changes']) {
      expect(agentFailureKindFromCause(cause)).toBe('agent')
    }
  })

  it('returns undefined for an absent/unknown cause (caller falls back to the error regex)', () => {
    expect(agentFailureKindFromCause(undefined)).toBeUndefined()
    expect(agentFailureKindFromCause('something-new')).toBeUndefined()
    // Eviction is never a harness cause — it routes through isContainerEvictionError, not here.
    expect(agentFailureKindFromCause('evicted')).toBeUndefined()
  })
})

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
