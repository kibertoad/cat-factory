import { describe, expect, it } from 'vitest'
import {
  decideTesterInfra,
  resolveTesterEnvironment,
  type TesterInfraInput,
} from './tester-infra.logic.js'

const base: TesterInfraInput = {
  localTestInfraSupported: true,
  environment: 'ephemeral',
  noInfraDependencies: false,
  hasComposePath: false,
  hasEnvironmentProvider: false,
  requireEnvironmentProvider: false,
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

    it('passes an ephemeral task that requires a provider when one is connected', () => {
      expect(
        decideTesterInfra({
          ...base,
          environment: 'ephemeral',
          requireEnvironmentProvider: true,
          hasEnvironmentProvider: true,
        }),
      ).toEqual({ ok: true })
    })

    it('refuses an ephemeral task that requires a provider when none is connected', () => {
      // The local-mode "delegate test environments" opt-in: a capable runtime would
      // otherwise pass ephemeral and fail later at provision time.
      expect(
        decideTesterInfra({
          ...base,
          environment: 'ephemeral',
          requireEnvironmentProvider: true,
          hasEnvironmentProvider: false,
        }),
      ).toEqual({ ok: false, reason: 'ephemeral-no-provider' })
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

describe('resolveTesterEnvironment', () => {
  it('honours a task pin over everything', () => {
    expect(resolveTesterEnvironment('local', 'ephemeral', 'ephemeral')).toBe('local')
    expect(resolveTesterEnvironment('ephemeral', 'local', 'local')).toBe('ephemeral')
  })

  it('falls back to the service default when the task has no pin', () => {
    expect(resolveTesterEnvironment(undefined, 'local', 'ephemeral')).toBe('local')
    expect(resolveTesterEnvironment(undefined, 'ephemeral', 'local')).toBe('ephemeral')
  })

  it('falls back to the deployment fallback when neither task nor service pins', () => {
    // Local mode passes `local` (host Docker / DinD) by default…
    expect(resolveTesterEnvironment(undefined, undefined, 'local')).toBe('local')
    // …flipping to `ephemeral` when the workspace opts into its provider.
    expect(resolveTesterEnvironment(undefined, undefined, 'ephemeral')).toBe('ephemeral')
  })

  it('defaults the fallback to `ephemeral` (Cloudflare/Node) when omitted', () => {
    expect(resolveTesterEnvironment(undefined, undefined)).toBe('ephemeral')
  })

  it('ignores an unrecognised task value and falls through', () => {
    expect(resolveTesterEnvironment('garbage', undefined, 'local')).toBe('local')
  })
})
