import { describe, expect, it } from 'vitest'
import { ENV_CONSUMER_STARVATION_REASONS } from '@cat-factory/contracts'
import {
  CONSUMER_ENVIRONMENT_FAULT_MESSAGES,
  consumerEnvironmentFault,
  decideTesterInfra,
  type TesterInfraInput,
} from './tester-infra.logic.js'

const base: TesterInfraInput = {
  provisionType: undefined,
  handlerResolves: true,
}

describe('decideTesterInfra', () => {
  it('passes when no provisioning is declared (run with no infra)', () => {
    expect(decideTesterInfra({ ...base, provisionType: undefined })).toEqual({ ok: true })
  })

  it('passes an `infraless` service', () => {
    expect(decideTesterInfra({ ...base, provisionType: 'infraless' })).toEqual({ ok: true })
  })

  describe('docker-compose / kubernetes / custom (provisioned by a workspace handler)', () => {
    for (const provisionType of ['docker-compose', 'kubernetes', 'custom'] as const) {
      it(`passes a ${provisionType} service when a handler resolves`, () => {
        expect(decideTesterInfra({ ...base, provisionType, handlerResolves: true })).toEqual({
          ok: true,
        })
      })

      it(`refuses a ${provisionType} service when no handler resolves`, () => {
        expect(decideTesterInfra({ ...base, provisionType, handlerResolves: false })).toEqual({
          ok: false,
          reason: 'provision-type-unhandled',
        })
      })
    }
  })

  describe('frontend (self-contained UI test)', () => {
    it('passes when at least one bound service has a live ephemeral env (the service under test)', () => {
      expect(
        decideTesterInfra({
          ...base,
          frontend: { hasServiceBindings: true, hasLiveService: true },
        }),
      ).toEqual({ ok: true })
    })

    it('refuses when it binds a service but none has a live env (no service under test)', () => {
      expect(
        decideTesterInfra({
          ...base,
          frontend: { hasServiceBindings: true, hasLiveService: false },
        }),
      ).toEqual({ ok: false, reason: 'frontend-no-live-service' })
    })

    it('passes a mock-only frontend (no live-backend service binding to gate on)', () => {
      // Nothing to test against a live backend — WireMock + the static server fully stand it up.
      expect(
        decideTesterInfra({
          ...base,
          frontend: { hasServiceBindings: false, hasLiveService: false },
        }),
      ).toEqual({ ok: true })
    })

    it('takes precedence over the provision-type branch (a frontend declares no provisioning)', () => {
      // A frontend with a live service passes even though the (irrelevant) backend inputs would
      // otherwise refuse — the frontend branch is decided first and ignores provisionType.
      expect(
        decideTesterInfra({
          frontend: { hasServiceBindings: true, hasLiveService: true },
          provisionType: 'docker-compose',
          handlerResolves: false,
        }),
      ).toEqual({ ok: true })
    })
  })
})

describe('consumerEnvironmentFault', () => {
  /** The reason the guard returned, or null: the shape every assertion below reads. */
  const fault = (
    agentKinds: string[],
    enabled: boolean[] | undefined,
    provisionType: Parameters<typeof consumerEnvironmentFault>[2],
  ) => consumerEnvironmentFault(agentKinds, enabled, provisionType)?.reason ?? null

  it('refuses a kubernetes chain whose tester has no deployer before it', () => {
    expect(fault(['coder', 'tester-api', 'merger'], undefined, 'kubernetes')).toBe(
      'consumer_without_deployer',
    )
  })

  it('refuses a chain whose disposer reclaims the environment before its tester reads it', () => {
    // The other direction of the same dead end, and the one a deployer-presence check misses:
    // something DID provision, and it is gone again by the time the tester runs.
    expect(fault(['coder', 'deployer', 'disposer', 'tester-api'], undefined, 'kubernetes')).toBe(
      'consumer_after_disposer',
    )
  })

  it('anchors the fault on the starved step, so the message can name it', () => {
    expect(
      consumerEnvironmentFault(
        ['coder', 'deployer', 'disposer', 'human-test'],
        undefined,
        'custom',
      ),
    ).toEqual({ reason: 'consumer_after_disposer', index: 3, agentKind: 'human-test' })
  })

  it('passes once a deployer precedes the first consumer', () => {
    expect(fault(['coder', 'deployer', 'tester-api', 'merger'], undefined, 'custom')).toBeNull()
  })

  it('passes a chain that re-provisions for the consumer after the disposer', () => {
    expect(
      fault(['deployer', 'tester-api', 'disposer', 'deployer', 'human-test'], undefined, 'custom'),
    ).toBeNull()
  })

  it('passes a chain with no env-consumer at all', () => {
    expect(fault(['coder', 'reviewer', 'merger'], undefined, 'kubernetes')).toBeNull()
  })

  it('fires for docker-compose (now Deployer-provisioned like kubernetes/custom)', () => {
    expect(fault(['coder', 'tester-api', 'merger'], undefined, 'docker-compose')).toBe(
      'consumer_without_deployer',
    )
  })

  it('never fires for infraless / undeclared services', () => {
    const chain = ['coder', 'tester-api', 'merger']
    expect(fault(chain, undefined, 'infraless')).toBeNull()
    expect(fault(chain, undefined, undefined)).toBeNull()
  })

  it('covers human-test and playwright as env-consumers', () => {
    expect(fault(['coder', 'human-test'], undefined, 'kubernetes')).toBe(
      'consumer_without_deployer',
    )
    expect(fault(['coder', 'playwright'], undefined, 'kubernetes')).toBe(
      'consumer_without_deployer',
    )
  })

  it('ignores a DISABLED deployer but honours a disabled consumer', () => {
    // A disabled deployer never runs, so it does not satisfy the guard.
    expect(fault(['deployer', 'tester-api'], [false, true], 'kubernetes')).toBe(
      'consumer_without_deployer',
    )
    // A disabled consumer imposes no requirement.
    expect(fault(['coder', 'tester-api'], [true, false], 'kubernetes')).toBeNull()
  })

  it('says nothing about a lifecycle that is merely untidy, which the run door does not own', () => {
    // A deployer nobody reclaims is refused when a pipeline is AUTHORED and still runs when a
    // stored one is started: every workspace seeded before that rule holds such a chain.
    expect(fault(['deployer', 'tester-api'], undefined, 'kubernetes')).toBeNull()
    expect(fault(['disposer', 'deployer', 'tester-api'], undefined, 'kubernetes')).toBeNull()
  })

  it('keeps a message for every reason it can return', () => {
    // Derived from the same list the guard filters by, so a reason added to one half cannot ship
    // without the copy the other half renders.
    for (const reason of ENV_CONSUMER_STARVATION_REASONS) {
      expect(CONSUMER_ENVIRONMENT_FAULT_MESSAGES[reason]('tester-api', 'kubernetes')).toContain(
        'tester-api',
      )
    }
  })
})
