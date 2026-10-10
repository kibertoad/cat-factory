import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  applyInfraSetupTransition,
  INFRA_SETUP_AREAS,
  INFRA_SETUP_HEALTH_STATUSES,
  INFRA_SETUP_PROBED_AREAS,
  infraSetupSchema,
  infraSetupStatusSchema,
  isInfraSetupHealthStatus,
  isInfraSetupProbedArea,
} from './infra-setup.js'

describe('infraSetupStatusSchema', () => {
  it('accepts every status including the health state', () => {
    for (const status of ['not_defined', 'configured', 'not_applicable', 'unreachable']) {
      expect(v.is(infraSetupStatusSchema, status)).toBe(true)
    }
  })

  it('still rejects an unknown status', () => {
    expect(v.is(infraSetupStatusSchema, 'broken')).toBe(false)
    expect(v.is(infraSetupStatusSchema, '')).toBe(false)
  })

  it('accepts `unreachable` for any area on the projection', () => {
    const projection = {
      ephemeralEnvironments: 'unreachable',
      agentExecutor: 'configured',
      binaryStorage: 'not_defined',
    }
    expect(v.is(infraSetupSchema, projection)).toBe(true)
  })
})

describe('isInfraSetupHealthStatus', () => {
  it('is true only for a live-health failure', () => {
    expect(isInfraSetupHealthStatus('unreachable')).toBe(true)
  })

  it('is false for the operator-decision states', () => {
    // These three are stable decisions, so the banner may offer its PERMANENT "don't notify me
    // again" dismissal for them. The guard exists so that dismissal can never be offered for a
    // transient outage, where one click would silence every future occurrence.
    expect(isInfraSetupHealthStatus('not_defined')).toBe(false)
    expect(isInfraSetupHealthStatus('configured')).toBe(false)
    expect(isInfraSetupHealthStatus('not_applicable')).toBe(false)
  })

  it('agrees with the exported health-status list', () => {
    for (const status of INFRA_SETUP_HEALTH_STATUSES) {
      expect(isInfraSetupHealthStatus(status)).toBe(true)
    }
    // Every status is classified one way or the other — a new one added to the picklist without a
    // decision about its dismissal semantics shows up here as an unclassified value.
    const all = infraSetupStatusSchema.options
    const health = all.filter(isInfraSetupHealthStatus)
    expect(health).toEqual([...INFRA_SETUP_HEALTH_STATUSES])
    expect(all.length).toBeGreaterThan(health.length)
  })
})

describe('INFRA_SETUP_AREAS', () => {
  it('still mirrors the projection keys exactly', () => {
    // Guards the invariant the banner's exhaustive Record relies on.
    expect([...INFRA_SETUP_AREAS].sort()).toEqual(Object.keys(infraSetupSchema.entries).sort())
  })
})

describe('INFRA_SETUP_PROBED_AREAS', () => {
  it('is a strict subset of the areas', () => {
    for (const area of INFRA_SETUP_PROBED_AREAS) {
      expect(INFRA_SETUP_AREAS).toContain(area)
    }
    // `binaryStorage` has no reachability probe, so it must stay out — a watcher that "probed" it
    // could only ever re-report the presence check the projection already does.
    expect(INFRA_SETUP_PROBED_AREAS.length).toBeLessThan(INFRA_SETUP_AREAS.length)
    expect([...INFRA_SETUP_PROBED_AREAS]).not.toContain('binaryStorage')
  })

  it('narrows through the guard', () => {
    expect(isInfraSetupProbedArea('agentExecutor')).toBe(true)
    expect(isInfraSetupProbedArea('ephemeralEnvironments')).toBe(true)
    expect(isInfraSetupProbedArea('binaryStorage')).toBe(false)
  })
})

describe('applyInfraSetupTransition', () => {
  const projection = (over: Partial<Record<string, string>> = {}) =>
    ({
      ephemeralEnvironments: 'configured',
      agentExecutor: 'configured',
      binaryStorage: 'configured',
      ...over,
    }) as never

  it('downgrades a configured area to unreachable', () => {
    expect(applyInfraSetupTransition(projection(), 'agentExecutor', 'unreachable')).toEqual(
      projection({ agentExecutor: 'unreachable' }),
    )
  })

  it('clears an unreachable area on recovery', () => {
    const input = projection({ agentExecutor: 'unreachable' })
    expect(applyInfraSetupTransition(input, 'agentExecutor', 'configured')).toEqual(projection())
  })

  it('refuses to overwrite the states that OUT-RANK a probe', () => {
    // The rule both delivery paths share. `not_defined` means the connection is gone (the
    // actionable nag is "set it up") and `not_applicable` means this deployment does not use the
    // area at all — reporting either as an outage blames the operator's cluster for our own state.
    // Identity is returned so a caller can tell "nothing moved" from a real transition.
    for (const current of ['not_defined', 'not_applicable'] as const) {
      const input = projection({ agentExecutor: current })
      expect(applyInfraSetupTransition(input, 'agentExecutor', 'unreachable')).toBe(input)
      expect(applyInfraSetupTransition(input, 'agentExecutor', 'configured')).toBe(input)
    }
  })

  it('is idempotent for an already-recorded outage', () => {
    const input = projection({ agentExecutor: 'unreachable' })
    expect(applyInfraSetupTransition(input, 'agentExecutor', 'unreachable')).toBe(input)
  })

  it('touches only the named area', () => {
    const out = applyInfraSetupTransition(projection(), 'agentExecutor', 'unreachable')
    expect(out.ephemeralEnvironments).toBe('configured')
    expect(out.binaryStorage).toBe('configured')
  })
})
