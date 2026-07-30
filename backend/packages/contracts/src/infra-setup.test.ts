import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  INFRA_SETUP_AREAS,
  INFRA_SETUP_HEALTH_STATUSES,
  INFRA_SETUP_PROBED_AREAS,
  infraSetupSchema,
  infraSetupStatusSchema,
  isInfraSetupHealthStatus,
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
})
