import { describe, expect, it } from 'vitest'
import {
  decideTesterInfra,
  needsDeployerBeforeConsumer,
  type TesterInfraInput,
} from './tester-infra.logic.js'

const base: TesterInfraInput = {
  provisionType: undefined,
  localTestInfraSupported: true,
  hasComposePath: true,
  handlerResolves: true,
}

describe('decideTesterInfra', () => {
  it('passes when no provisioning is declared (run with no infra)', () => {
    expect(decideTesterInfra({ ...base, provisionType: undefined })).toEqual({ ok: true })
  })

  it('passes an `infraless` service', () => {
    expect(decideTesterInfra({ ...base, provisionType: 'infraless' })).toEqual({ ok: true })
  })

  describe('docker-compose (stood up in-container)', () => {
    it('passes on a DinD-capable runtime with a compose path', () => {
      expect(
        decideTesterInfra({
          ...base,
          provisionType: 'docker-compose',
          localTestInfraSupported: true,
          hasComposePath: true,
        }),
      ).toEqual({ ok: true })
    })

    it('refuses on a runtime that cannot nest containers (Apple `container`)', () => {
      expect(
        decideTesterInfra({
          ...base,
          provisionType: 'docker-compose',
          localTestInfraSupported: false,
        }),
      ).toEqual({ ok: false, reason: 'limited-local' })
    })

    it('refuses a DinD-capable runtime when no compose path is declared (nothing to stand up)', () => {
      expect(
        decideTesterInfra({
          ...base,
          provisionType: 'docker-compose',
          localTestInfraSupported: true,
          hasComposePath: false,
        }),
      ).toEqual({ ok: false, reason: 'compose-unconfigured' })
    })

    it('refuses on no-DinD before the compose-path check (limited mode wins)', () => {
      expect(
        decideTesterInfra({
          ...base,
          provisionType: 'docker-compose',
          localTestInfraSupported: false,
          hasComposePath: false,
        }),
      ).toEqual({ ok: false, reason: 'limited-local' })
    })
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
          localTestInfraSupported: false,
          hasComposePath: false,
          handlerResolves: false,
        }),
      ).toEqual({ ok: true })
    })
  })

  describe('kubernetes / custom (provisioned by a workspace handler)', () => {
    for (const provisionType of ['kubernetes', 'custom'] as const) {
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
})

describe('needsDeployerBeforeConsumer', () => {
  it('refuses a kubernetes chain whose tester has no deployer before it', () => {
    expect(
      needsDeployerBeforeConsumer(['coder', 'tester-api', 'merger'], undefined, 'kubernetes'),
    ).toBe(true)
  })

  it('passes once a deployer precedes the first consumer', () => {
    expect(
      needsDeployerBeforeConsumer(
        ['coder', 'deployer', 'tester-api', 'merger'],
        undefined,
        'custom',
      ),
    ).toBe(false)
  })

  it('passes a chain with no env-consumer at all', () => {
    expect(
      needsDeployerBeforeConsumer(['coder', 'reviewer', 'merger'], undefined, 'kubernetes'),
    ).toBe(false)
  })

  it('never fires for docker-compose / infraless / undeclared services', () => {
    const chain = ['coder', 'tester-api', 'merger']
    expect(needsDeployerBeforeConsumer(chain, undefined, 'docker-compose')).toBe(false)
    expect(needsDeployerBeforeConsumer(chain, undefined, 'infraless')).toBe(false)
    expect(needsDeployerBeforeConsumer(chain, undefined, undefined)).toBe(false)
  })

  it('covers human-test and playwright as env-consumers', () => {
    expect(needsDeployerBeforeConsumer(['coder', 'human-test'], undefined, 'kubernetes')).toBe(true)
    expect(needsDeployerBeforeConsumer(['coder', 'playwright'], undefined, 'kubernetes')).toBe(true)
  })

  it('ignores a DISABLED deployer but honours a disabled consumer', () => {
    // A disabled deployer never runs, so it does not satisfy the guard.
    expect(
      needsDeployerBeforeConsumer(['deployer', 'tester-api'], [false, true], 'kubernetes'),
    ).toBe(true)
    // A disabled consumer imposes no requirement.
    expect(needsDeployerBeforeConsumer(['coder', 'tester-api'], [true, false], 'kubernetes')).toBe(
      false,
    )
  })
})
