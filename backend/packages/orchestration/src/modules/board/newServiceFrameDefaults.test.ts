import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKSPACE_SETTINGS, createRecordingLogger } from '@cat-factory/kernel'
import { defaultProvisioningFor, resolveDefaultProvisioning } from './newServiceFrameDefaults.js'

// The pure precedence behind the workspace's default test-environment provisioning mechanism.
// The two `undefined` cases are the load-bearing ones: they are what keeps "nobody chose" from
// being written onto every new service as if someone had.
describe('defaultProvisioningFor', () => {
  it('no recorded choice ⇒ seeds nothing (a new frame declares no provisioning, as before)', () => {
    expect(
      defaultProvisioningFor({ defaultProvisionType: null, defaultProvisionManifestId: null }),
    ).toBeUndefined()
  })

  it('a stale manifest id cannot resurrect a cleared choice', () => {
    expect(
      defaultProvisioningFor({
        defaultProvisionType: null,
        defaultProvisionManifestId: 'acme-preview',
      }),
    ).toBeUndefined()
  })

  it.each(['kubernetes', 'docker-compose', 'cloudflare', 'infraless'] as const)(
    'seeds %s as the service-declared type',
    (type) => {
      expect(
        defaultProvisioningFor({ defaultProvisionType: type, defaultProvisionManifestId: null }),
      ).toEqual({ type })
    },
  )

  it('an explicit infraless is a real decision, not the absent state', () => {
    // The distinction the whole nullable field exists for: this seeds `{ type: 'infraless' }`
    // where an unset default seeds nothing at all.
    expect(
      defaultProvisioningFor({
        defaultProvisionType: 'infraless',
        defaultProvisionManifestId: null,
      }),
    ).toEqual({ type: 'infraless' })
  })

  it('carries the pinned manifest id for a custom default', () => {
    expect(
      defaultProvisioningFor({
        defaultProvisionType: 'custom',
        defaultProvisionManifestId: 'acme-preview',
      }),
    ).toEqual({ type: 'custom', manifestId: 'acme-preview' })
  })

  it('refuses a custom default with no manifest id rather than seeding an unmatchable service', () => {
    // The service would declare `custom` but pin nothing, so no `remote-custom` handler could
    // ever match it — a failure that would only surface at the deployer step.
    expect(
      defaultProvisioningFor({ defaultProvisionType: 'custom', defaultProvisionManifestId: null }),
    ).toBeUndefined()
  })
})

describe('resolveDefaultProvisioning', () => {
  it('reads the workspace default through the settings seam', async () => {
    const logger = createRecordingLogger()
    const resolved = await resolveDefaultProvisioning('ws_1', {
      settings: {
        get: async () => ({ ...DEFAULT_WORKSPACE_SETTINGS, defaultProvisionType: 'kubernetes' }),
      },
      logger,
    })
    expect(resolved).toEqual({ type: 'kubernetes' })
  })

  it('an unwired settings seam is a pass-through', async () => {
    const logger = createRecordingLogger()
    expect(await resolveDefaultProvisioning('ws_1', { logger })).toBeUndefined()
    // Nothing FAILED here — the seam simply isn't wired — so this must not look like an incident.
    expect(logger.lines).toHaveLength(0)
  })

  it('a failing settings read degrades to no seed AND leaves evidence', async () => {
    const logger = createRecordingLogger()
    const resolved = await resolveDefaultProvisioning('ws_1', {
      settings: {
        get: async () => {
          throw new Error('settings store unreachable')
        },
      },
      logger,
    })
    // Creating the service the user asked for matters more than seeding a default onto it.
    expect(resolved).toBeUndefined()
    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]?.level).toBe('warn')
    expect(logger.lines[0]?.fields).toMatchObject({ workspaceId: 'ws_1' })
  })
})
