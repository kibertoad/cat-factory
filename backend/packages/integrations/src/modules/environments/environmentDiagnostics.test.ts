import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EnvironmentFailureFacts,
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

const remediationRows = vi.fn()
beforeEach(() => remediationRows.mockReset())

function deps(args: {
  found?: EnvironmentRecord | null
  readError?: Error
  fields?: Record<string, string>
  fieldsError?: Error
  provider?: EnvironmentProvider
  providerError?: Error
  log?: ProvisioningLogRecord[]
  logError?: Error
}) {
  return {
    readRecord: async () => {
      if (args.readError) throw args.readError
      return args.found === undefined ? record() : args.found
    },
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
    recordRemediation: remediationRows,
  }
}

const FAILURE: EnvironmentFailureFacts = {
  error: 'Environment was still provisioning after 20 minutes',
  reason: 'timeout',
  readinessWait: 'verdict_without_wait',
}

/** The bundle alone, for the assertions that are about the evidence rather than the capability. */
async function collectBundle(
  diagnostics: ReturnType<typeof createEnvironmentDiagnostics>,
  args: { environmentId: string | null; executionId?: string },
) {
  const { bundle } = await diagnostics.collect({
    workspaceId: 'ws1',
    ...args,
    failure: FAILURE,
  })
  return bundle
}

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
    const bundle = await collectBundle(diagnostics, { environmentId: 'env_1' })
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
    const bundle = await collectBundle(diagnostics, { environmentId: 'env_1' })
    expect(bundle.provisionFields.namespace).toBe('pr-42')
    expect(bundle.provisionFields.apiToken).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345')
  })

  it('states that the provider offers no diagnosis rather than omitting the section', async () => {
    const diagnostics = createEnvironmentDiagnostics(deps({}))
    const bundle = await collectBundle(diagnostics, { environmentId: 'env_1' })
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
    const bundle = await collectBundle(diagnostics, { environmentId: 'env_1' })
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
    const bundle = await collectBundle(diagnostics, { environmentId: 'env_1' })
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
    const bundle = await collectBundle(diagnostics, { environmentId: 'env_1' })
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
    const bundle = await collectBundle(diagnostics, {
      environmentId: 'env_1',
      executionId: 'exec_1',
    })
    expect(bundle.timeline.map((entry) => entry.at)).toEqual([1_000, 2_000, 3_000])
    expect(bundle.timeline[2]?.label).toContain('environment.status failure')
  })

  it('names a provisioning log it could not read rather than reporting an empty history', async () => {
    const diagnostics = createEnvironmentDiagnostics(deps({ logError: new Error('D1 is down') }))
    const bundle = await collectBundle(diagnostics, {
      environmentId: 'env_1',
      executionId: 'exec_1',
    })
    expect(bundle.timeline.some((e) => e.detail === 'D1 is down')).toBe(true)
  })

  it('names undecryptable provision fields rather than presenting an empty bag', async () => {
    const diagnostics = createEnvironmentDiagnostics(
      deps({ fieldsError: new Error('the org key is unavailable') }),
    )
    const bundle = await collectBundle(diagnostics, { environmentId: 'env_1' })
    expect(bundle.provisionFields).toEqual({})
    expect(bundle.timeline.some((e) => e.label.includes('could not be decrypted'))).toBe(true)
  })

  it('reports an UNKNOWN status when no environment was ever recorded', async () => {
    const diagnostics = createEnvironmentDiagnostics(deps({ found: null }))
    const bundle = await collectBundle(diagnostics, { environmentId: null })
    // Never `failed`: nothing was read, and a status invented here is the fact the investigation
    // would trust most.
    expect(bundle.environment.status).toBe('unknown')
    expect(bundle.diagnosisUnavailable).toContain('before an environment was recorded')
  })

  it('degrades when the registry read THROWS instead of failing the caller with it', async () => {
    // The gather runs on a path that has already failed, and its caller's next move is to record
    // that failure. A throw here used to propagate out of the poll, where the durable driver reads
    // it as an unreadable poll and fast-fails the run as a `timeout`: the investigation replacing
    // the run's real problem with a misattributed one of its own.
    const diagnostics = createEnvironmentDiagnostics(deps({ readError: new Error('D1 is down') }))
    const bundle = await collectBundle(diagnostics, { environmentId: 'env_1' })
    expect(bundle.environment.status).toBe('unknown')
    expect(bundle.diagnosisUnavailable).toContain('could not be READ from the registry')
    expect(bundle.diagnosisUnavailable).toContain('D1 is down')
    // And it does NOT read as "the environment is gone", which is the opposite conclusion.
    expect(bundle.diagnosisUnavailable).not.toContain('no longer in the registry')
  })

  it("scrubs the PROVIDER's own diagnosis, which is mostly text it never authored", async () => {
    const dsn = 'postgres://app:s3cr3tpassword@db:5432/app'
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        provider: provider({
          diagnostics: {
            describe: vi.fn().mockResolvedValue({
              facts: [{ key: 'pods.web.status', value: `CrashLoopBackOff: cannot reach ${dsn}` }],
              logs: [{ source: 'pod/web', text: `FATAL: auth failed (${dsn})` }],
              gaps: [{ read: 'events', reason: `403 for token=abcd1234efgh5678` }],
            }),
          },
        }),
      }),
    )
    const bundle = await collectBundle(diagnostics, { environmentId: 'env_1' })
    expect(bundle.diagnosis?.facts[0]?.value).not.toContain('s3cr3tpassword')
    expect(bundle.diagnosis?.logs?.[0]?.text).not.toContain('s3cr3tpassword')
    expect(bundle.diagnosis?.gaps?.[0]?.reason).not.toContain('abcd1234efgh5678')
    // The surrounding context survives, or the excerpt stops being diagnostic.
    expect(bundle.diagnosis?.facts[0]?.value).toContain('CrashLoopBackOff')
  })

  it('bounds the bundle and STATES every section it cut', async () => {
    // The prompt is one string, so an uncapped section does not degrade the diagnosis, it costs
    // the whole round: the generation rejects on context length and the budget is spent with
    // nothing to show.
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        fields: Object.fromEntries(
          Array.from({ length: 200 }, (_, i) => [`field${i}`, 'v'.repeat(2000)]),
        ),
        provider: provider({
          diagnostics: {
            describe: vi.fn().mockResolvedValue({
              facts: Array.from({ length: 400 }, (_, i) => ({
                key: `pods.p${i}.status`,
                value: 'x'.repeat(2000),
              })),
            }),
          },
        }),
      }),
    )
    const bundle = await collectBundle(diagnostics, { environmentId: 'env_1' })
    expect(bundle.diagnosis?.facts.length).toBeLessThan(400)
    expect(Object.keys(bundle.provisionFields).length).toBeLessThan(200)
    expect(bundle.evidenceCaps?.join('\n')).toContain('400 facts')
    expect(bundle.evidenceCaps?.join('\n')).toContain('200 provision fields')
    // Every value that was cut says so where it was cut.
    expect(bundle.diagnosis?.facts[0]?.value).toContain('more characters were not included')
    expect(Object.values(bundle.provisionFields)[0]).toContain('more characters were not included')
  })

  it('says how many older timeline rows the cap dropped', async () => {
    const rows: ProvisioningLogRecord[] = Array.from({ length: 60 }, (_, i) => ({
      id: `l${i}`,
      workspaceId: 'ws1',
      subsystem: 'environment',
      operation: 'status',
      targetId: 'env_1',
      providerId: 'kargo',
      blockId: 'blk1',
      executionId: 'exec_1',
      outcome: 'failure',
      error: null,
      detail: null,
      createdAt: 10_000 - i,
    }))
    const diagnostics = createEnvironmentDiagnostics(deps({ log: rows }))
    const bundle = await collectBundle(diagnostics, {
      environmentId: 'env_1',
      executionId: 'exec_1',
    })
    expect(bundle.timeline.some((e) => e.label.includes('20 older provisioning-log rows'))).toBe(
      true,
    )
  })
})

describe("createEnvironmentDiagnostics.collect's declared provider actions", () => {
  async function actionsFor(d: ReturnType<typeof createEnvironmentDiagnostics>) {
    const { providerActions } = await d.collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      failure: FAILURE,
    })
    return providerActions
  }

  it('offers nothing for a provider with no diagnostics', async () => {
    expect(await actionsFor(createEnvironmentDiagnostics(deps({})))).toEqual([])
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
    expect(await actionsFor(diagnostics)).toEqual([])
  })

  it('offers what a fully implemented capability declares', async () => {
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        provider: provider({
          diagnostics: { describe: vi.fn(), supportedActions: ['restart'], remediate: vi.fn() },
        }),
      }),
    )
    expect(await actionsFor(diagnostics)).toEqual(['restart'])
  })

  it('resolves the provider ONCE for the bundle and the capability together', async () => {
    // Two calls per round is a second registry read plus a second connection open, which is a
    // `/internal/persistence` round trip for a mothership node.
    const d = deps({
      provider: provider({
        diagnostics: { describe: vi.fn().mockResolvedValue({ facts: [] }), remediate: vi.fn() },
      }),
    })
    const resolveProvider = vi.fn(d.resolveProvider)
    const readRecord = vi.fn(d.readRecord)
    await createEnvironmentDiagnostics({ ...d, resolveProvider, readRecord }).collect({
      workspaceId: 'ws1',
      environmentId: 'env_1',
      failure: FAILURE,
    })
    expect(resolveProvider).toHaveBeenCalledTimes(1)
    expect(readRecord).toHaveBeenCalledTimes(1)
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

  it('appends a `remediate` row, so the next round can see the cluster was touched', async () => {
    // The investigation's own second round rebuilds its timeline from this log. Unlogged, a
    // restart leaves the next round reasoning about an environment it believes is untouched.
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        provider: provider({
          diagnostics: {
            describe: vi.fn(),
            supportedActions: ['restart'],
            remediate: vi.fn().mockResolvedValue({ applied: true, detail: 'rolled 2 Deployments' }),
          },
        }),
      }),
    )
    await diagnostics.remediate({ workspaceId: 'ws1', environmentId: 'env_1', action: 'restart' })
    expect(remediationRows).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws1',
        environmentId: 'env_1',
        providerId: 'kargo',
        executionId: 'exec_1',
        outcome: 'success',
      }),
    )
    expect(JSON.parse(remediationRows.mock.calls[0]?.[0].detail)).toMatchObject({
      action: 'restart',
      applied: true,
    })
  })

  it('records a FAILURE row for a remediation that ran and did nothing', async () => {
    // `applied: false` means the requested remediation did not happen, and the timeline's job is
    // to say whether anything touched this environment.
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        provider: provider({
          diagnostics: {
            describe: vi.fn(),
            supportedActions: ['restart'],
            remediate: vi
              .fn()
              .mockResolvedValue({ applied: false, detail: 'no Deployment to restart' }),
          },
        }),
      }),
    )
    await diagnostics.remediate({ workspaceId: 'ws1', environmentId: 'env_1', action: 'restart' })
    expect(remediationRows).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', error: 'no Deployment to restart' }),
    )
  })

  it('records a row for a remediation that THREW, then rethrows', async () => {
    const diagnostics = createEnvironmentDiagnostics(
      deps({
        provider: provider({
          diagnostics: {
            describe: vi.fn(),
            supportedActions: ['restart'],
            remediate: vi.fn().mockRejectedValue(new Error('apiserver refused the patch')),
          },
        }),
      }),
    )
    await expect(
      diagnostics.remediate({ workspaceId: 'ws1', environmentId: 'env_1', action: 'restart' }),
    ).rejects.toThrow('apiserver refused the patch')
    expect(remediationRows).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', error: 'apiserver refused the patch' }),
    )
  })
})
