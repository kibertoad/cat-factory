import { describe, expect, it } from 'vitest'
import { decideTesterInfra, type TesterInfraInput } from './tester-infra.logic.js'

const base: TesterInfraInput = {
  localTestInfraSupported: true,
  environment: 'ephemeral',
  noInfraDependencies: false,
  hasComposePath: false,
  hasEnvironmentProvider: false,
}

describe('decideTesterInfra', () => {
  describe('capable runtime (Docker/Podman/OrbStack/Colima)', () => {
    it('passes an ephemeral task with no service config (zero-config default)', () => {
      expect(decideTesterInfra({ ...base, environment: 'ephemeral' })).toEqual({ ok: true })
    })

    it('passes a local task with a compose path', () => {
      expect(decideTesterInfra({ ...base, environment: 'local', hasComposePath: true })).toEqual({
        ok: true,
      })
    })

    it('passes a local task marked no-infra', () => {
      expect(
        decideTesterInfra({ ...base, environment: 'local', noInfraDependencies: true }),
      ).toEqual({ ok: true })
    })

    it('refuses a local task with neither compose path nor no-infra', () => {
      expect(decideTesterInfra({ ...base, environment: 'local' })).toEqual({
        ok: false,
        reason: 'local-unconfigured',
      })
    })
  })

  describe('limited runtime (Apple `container` — no Docker-in-Docker)', () => {
    const limited = { ...base, localTestInfraSupported: false }

    it("refuses a local task even with a compose path (can't nest)", () => {
      expect(decideTesterInfra({ ...limited, environment: 'local', hasComposePath: true })).toEqual(
        { ok: false, reason: 'limited-local' },
      )
    })

    it('allows a local task when the service stands nothing up (no-infra)', () => {
      expect(
        decideTesterInfra({ ...limited, environment: 'local', noInfraDependencies: true }),
      ).toEqual({ ok: true })
    })

    it('allows an ephemeral task when an environment provider is configured (offloaded)', () => {
      expect(
        decideTesterInfra({ ...limited, environment: 'ephemeral', hasEnvironmentProvider: true }),
      ).toEqual({ ok: true })
    })

    it('refuses an ephemeral task with no provider (nothing to test against)', () => {
      expect(decideTesterInfra({ ...limited, environment: 'ephemeral' })).toEqual({
        ok: false,
        reason: 'limited-ephemeral-no-provider',
      })
    })
  })
})
