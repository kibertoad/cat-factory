import { describe, expect, it, vi } from 'vitest'
import type {
  EnvironmentManifest,
  EnvironmentProvider,
  EnvironmentRecord,
  ProvisioningLogRecord,
} from '@cat-factory/kernel'
import { createEnvironmentDiagnostics } from './environmentDiagnostics.js'

const MANIFEST = { providerId: 'kargo' } as unknown as EnvironmentManifest

function record(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: 'env_1',
    workspaceId: 'ws1',
    blockId: 'blk1',
    frameId: 'frame1',
    executionId: 'exec_1',
    providerId: 'kargo',
    externalId: 'prenv-42',
    url: 'https://pr-42.example.test',
    status: 'ready',
    accessCipher: null,
    provisionFieldsCipher: 'cipher',
    createdAt: 1_000,
    expiresAt: null,
    lastError: null,
    deletedAt: null,
    provisionType: 'preview',
    engine: 'remote-custom',
    ...overrides,
  }
}

function provider(overrides: Partial<EnvironmentProvider> = {}): EnvironmentProvider {
  return {
    provision: vi.fn(),
    status: vi.fn(),
    teardown: vi.fn(),
    ...overrides,
  } as unknown as EnvironmentProvider
}

function deps(args: {
  found?: EnvironmentRecord | null
  fields?: Record<string, string>
  fieldsError?: Error
  provider?: EnvironmentProvider
  providerError?: Error
  log?: ProvisioningLogRecord[]
  logError?: Error
}) {
  return {
    readRecord: async () => (args.found === undefined ? record() : args.found),
    resolveProvider: async () => {
      if (args.providerError) throw args.providerError
      return {
        manifest: MANIFEST,
        provider: args.provider ?? provider(),
        resolveSecret: () => undefined,
      }
    },
    decryptFields: async () => {
      if (args.fieldsError) throw args.fieldsError
      return args.fields ?? {}
    },
    listProvisioningLog: async () => {
      if (args.logError) throw args.logError
      return args.log ?? []
    },
  }
}

const FAILURE = { error: 'Environment was still provisioning after 20 minutes', reason: 'timeout' }

describe('createEnvironmentDiagnostics.collect', () => {
  it('carries the WHOLE provision-field bag, which is where the evidence already was', async () => {
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        fields: {
          namespace: 'pr-42',
          kargoBalancers: '[{"healthy":false},{"healthy":false}]',
          urlHostResolves: 'false',
          urlReachability: 'NXDOMAIN for pr-42.example.test',
        },
      }),
    )
    const bundle = await diagnostics.collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      failure: FAILURE,
    })
    // The four fields `resolveForBlock` projects are not the interesting ones: the adapter's own
    // per-poll observations are, and nothing has ever read them.
    expect(bundle.provisionFields).toMatchObject({
      kargoBalancers: '[{"healthy":false},{"healthy":false}]',
      urlHostResolves: 'false',
      urlReachability: 'NXDOMAIN for pr-42.example.test',
    })
  })

  it('redacts a secret-shaped provision field using its own key as context', async () => {
    const diagnostics = createEnvironmentDiagnostics(
      deps({ fields: { namespace: 'pr-42', apiToken: 'ghp_abcdefghijklmnopqrstuvwxyz012345' } }),
    )
    const bundle = await diagnostics.collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      failure: FAILURE,
    })
    expect(bundle.provisionFields.namespace).toBe('pr-42')
    expect(bundle.provisionFields.apiToken).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345')
  })

  it('states that the provider offers no diagnosis rather than omitting the section', async () => {
    const diagnostics = createEnvironmentDiagnostics(deps({}))
    const bundle = await diagnostics.collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      failure: FAILURE,
    })
    expect(bundle.diagnosis).toBeUndefined()
    expect(bundle.diagnosisUnavailable).toContain('implements no diagnostics')
    expect(bundle.diagnosisUnavailable).toContain('UNKNOWN')
  })

  it("carries the provider's diagnosis when it implements one", async () => {
    const describe_ = vi.fn().mockResolvedValue({
      facts: [{ key: 'jobs[0].vm.status', value: 'offline', healthy: false }],
      gaps: [{ read: 'pod logs', reason: 'no grant', permanent: true }],
    })
    const diagnostics = createEnvironmentDiagnostics(
      deps({ provider: provider({ diagnostics: { describe: describe_ } }) }),
    )
    const bundle = await diagnostics.collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      failure: FAILURE,
    })
    expect(bundle.diagnosis?.facts[0]).toEqual({
      key: 'jobs[0].vm.status',
      value: 'offline',
      healthy: false,
    })
    expect(bundle.diagnosisUnavailable).toBeUndefined()
  })

  it('names a describe that THREW instead of reporting an environment with nothing wrong', async () => {
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        provider: provider({
          diagnostics: { describe: vi.fn().mockRejectedValue(new Error('apiserver timed out')) },
        }),
      }),
    )
    const bundle = await diagnostics.collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      failure: FAILURE,
    })
    expect(bundle.diagnosis).toBeUndefined()
    expect(bundle.diagnosisUnavailable).toContain('apiserver timed out')
  })

  it('caps a long log excerpt from its TAIL and marks it truncated', async () => {
    const text = `${'head'.repeat(2000)}THE-CRASH`
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        provider: provider({
          diagnostics: {
            describe: vi.fn().mockResolvedValue({ facts: [], logs: [{ source: 'pod/api', text }] }),
          },
        }),
      }),
    )
    const bundle = await diagnostics.collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      failure: FAILURE,
    })
    const log = bundle.diagnosis?.logs?.[0]
    expect(log?.truncated).toBe(true)
    // The end of a failing container's output is where the cause is.
    expect(log?.text.endsWith('THE-CRASH')).toBe(true)
    expect(log?.text.length).toBeLessThan(text.length)
  })

  it('builds the timeline oldest-first from the run log', async () => {
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        log: [
          {
            id: 'l2',
            workspaceId: 'ws1',
            subsystem: 'environment',
            operation: 'status',
            targetId: 'env_1',
            providerId: 'kargo',
            blockId: 'blk1',
            executionId: 'exec_1',
            outcome: 'failure',
            error: 'still provisioning',
            detail: null,
            createdAt: 3_000,
          },
          {
            id: 'l1',
            workspaceId: 'ws1',
            subsystem: 'environment',
            operation: 'provision',
            targetId: 'env_1',
            providerId: 'kargo',
            blockId: 'blk1',
            executionId: 'exec_1',
            outcome: 'success',
            error: null,
            detail: null,
            createdAt: 2_000,
          },
        ],
      }),
    )
    const bundle = await diagnostics.collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      executionId: 'exec_1',
      failure: FAILURE,
    })
    expect(bundle.timeline.map((entry) => entry.at)).toEqual([1_000, 2_000, 3_000])
    expect(bundle.timeline[2]?.label).toContain('environment.status failure')
  })

  it('names a provisioning log it could not read rather than reporting an empty history', async () => {
    const diagnostics = createEnvironmentDiagnostics(deps({ logError: new Error('D1 is down') }))
    const bundle = await diagnostics.collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      executionId: 'exec_1',
      failure: FAILURE,
    })
    expect(bundle.timeline.some((e) => e.detail === 'D1 is down')).toBe(true)
  })

  it('names undecryptable provision fields rather than presenting an empty bag', async () => {
    const diagnostics = createEnvironmentDiagnostics(
      deps({ fieldsError: new Error('the org key is unavailable') }),
    )
    const bundle = await diagnostics.collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      failure: FAILURE,
    })
    expect(bundle.provisionFields).toEqual({})
    expect(bundle.timeline.some((e) => e.label.includes('could not be decrypted'))).toBe(true)
  })

  it('reports an UNKNOWN status when no environment was ever recorded', async () => {
    const diagnostics = createEnvironmentDiagnostics(deps({ found: null }))
    const bundle = await diagnostics.collect({
      workspaceId: 'ws1',
      environmentId: null,
      failure: FAILURE,
    })
    // Never `failed`: nothing was read, and a status invented here is the fact the investigation
    // would trust most.
    expect(bundle.environment.status).toBe('unknown')
    expect(bundle.diagnosisUnavailable).toContain('before an environment was recorded')
  })
})

describe('createEnvironmentDiagnostics.providerActions', () => {
  it('offers nothing for a provider with no diagnostics', async () => {
    const diagnostics = createEnvironmentDiagnostics(deps({}))
    expect(await diagnostics.providerActions('ws1', 'env_1')).toEqual([])
  })

  it('offers nothing for a provider that DECLARES actions but implements no remediate', async () => {
    // A half-declared capability answers no to "will something happen if I ask", which is the
    // engine's only question.
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        provider: provider({
          diagnostics: { describe: vi.fn(), supportedActions: ['restart'] },
        }),
      }),
    )
    expect(await diagnostics.providerActions('ws1', 'env_1')).toEqual([])
  })

  it('offers what a fully implemented capability declares', async () => {
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        provider: provider({
          diagnostics: { describe: vi.fn(), supportedActions: ['restart'], remediate: vi.fn() },
        }),
      }),
    )
    expect(await diagnostics.providerActions('ws1', 'env_1')).toEqual(['restart'])
  })
})

describe('createEnvironmentDiagnostics.remediate', () => {
  it('passes the decrypted fields through to the provider and returns its outcome', async () => {
    const remediate = vi.fn().mockResolvedValue({ applied: true, detail: 'rolled 2 Deployments' })
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        fields: { namespace: 'pr-42' },
        provider: provider({
          diagnostics: { describe: vi.fn(), supportedActions: ['restart'], remediate },
        }),
      }),
    )
    expect(
      await diagnostics.remediate({
        workspaceId: 'ws1',
        environmentId: 'env_1',
        action: 'restart',
      }),
    ).toEqual({ applied: true, detail: 'rolled 2 Deployments' })
    expect(remediate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restart', provisionFields: { namespace: 'pr-42' } }),
    )
  })

  it('throws when the capability is gone, so a no-op is never read as a remedy', async () => {
    const diagnostics = createEnvironmentDiagnostics(deps({}))
    await expect(
      diagnostics.remediate({ workspaceId: 'ws1', environmentId: 'env_1', action: 'restart' }),
    ).rejects.toThrow('no in-place remediation')
  })
})
