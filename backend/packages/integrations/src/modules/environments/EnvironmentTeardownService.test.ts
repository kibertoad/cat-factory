import { describe, expect, it, vi } from 'vitest'
import type {
  DelegatedSecretRef,
  EnvironmentProvider,
  EnvironmentRecord,
  EnvironmentRegistryRepository,
  ProvisioningOutcome,
  SecretCipher,
  SecretDelegate,
  TeardownProbe,
} from '@cat-factory/kernel'
import { EnvironmentTeardownService } from './EnvironmentTeardownService.js'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService.js'
import type { ProvisioningLogRecorder } from '../provisioning-logs/ProvisioningLogService.js'

// The teardown-recorded notification. Its consumer is the run's PR verification report, which
// re-reads the provisioning log when it fires, so two properties are load-bearing and neither is
// visible from the report's own tests: the hook fires on a FAILED attempt as well as a successful
// one (a settled run has no step hook left, so a refusing provider would otherwise never reach
// the PR), and it fires only AFTER the row it is telling the consumer about has landed.

const MANIFEST = {
  providerId: 'acme',
  label: 'Acme',
  baseUrl: 'https://envs.test/api',
  auth: { type: 'none' as const },
  provision: { method: 'POST' as const, pathTemplate: '/envs' },
  response: {},
}

const RECORD: EnvironmentRecord = {
  id: 'env_1',
  workspaceId: 'ws_1',
  blockId: 'task_login',
  frameId: 'frm_api',
  executionId: 'exec_1',
  providerId: 'acme',
  externalId: 'ext-1',
  url: 'https://preview.example',
  status: 'ready',
  accessCipher: null,
  provisionFieldsCipher: null,
  createdAt: 1_000,
  expiresAt: null,
  lastError: null,
  deletedAt: null,
  provisionType: null,
  engine: null,
}

const fakeCipher: SecretCipher = {
  encrypt: async (plaintext: string) => `enc:${plaintext}`,
  decrypt: async (cipher: string) => cipher.replace(/^enc:/, ''),
}

function fakeRegistry(record: EnvironmentRecord): EnvironmentRegistryRepository {
  const rows = [{ ...record }]
  const reads: Pick<EnvironmentRegistryRepository, 'get' | 'softDelete'> = {
    async get(_workspaceId, id) {
      return rows.find((r) => r.id === id) ?? null
    },
    async softDelete(_workspaceId, id, at) {
      const row = rows.find((r) => r.id === id)
      if (row) row.deletedAt = at
    },
  }
  return reads as EnvironmentRegistryRepository
}

/** Records what reached the log, in order, so the hook's ordering can be asserted against it. */
function fakeLog(): {
  rows: { operation: string; outcome: string }[]
  log: ProvisioningLogRecorder
} {
  const rows: { operation: string; outcome: string }[] = []
  const writes: Pick<ProvisioningLogRecorder, 'record'> = {
    async record(row) {
      rows.push({ operation: row.operation, outcome: row.outcome })
    },
  }
  return { rows, log: writes as ProvisioningLogRecorder }
}

function makeService(provider: EnvironmentProvider, log: ProvisioningLogRecorder) {
  const connectionService = {
    resolveProviderForRecord: async () => ({
      provider,
      manifest: MANIFEST,
      resolveSecret: () => undefined,
    }),
  } as unknown as EnvironmentConnectionService
  return new EnvironmentTeardownService({
    connectionService,
    environmentRegistryRepository: fakeRegistry(RECORD),
    secretCipher: fakeCipher,
    clock: { now: () => 2_000 },
    provisioningLog: log,
  })
}

const workingProvider = {
  async teardown() {
    return { status: 'torn_down' }
  },
} as unknown as EnvironmentProvider

const refusingProvider = {
  async teardown(): Promise<never> {
    throw new Error('provider refused: environment is locked')
  },
} as unknown as EnvironmentProvider

describe('EnvironmentTeardownService teardown-recorded hook', () => {
  it('notifies only after EVERY row for the teardown has landed, confirmation included', async () => {
    // The hook's one consumer is the PR verification report, which RE-READS the log to recompose
    // its environment section. Fired between the two rows it would see a teardown nothing had
    // verified — indistinguishable from one probed and found unproven — and publish `unconfirmed`
    // about an environment the very next write proves gone. Because this hook is the last edge on
    // an already-settled run, nothing would ever correct it, so the whole `confirmed` verdict
    // would be unreachable in production. `rowsAtCall` is the assertion that matters: it pins the
    // ORDER, which no assertion on the final rows can see.
    const { rows, log } = fakeLog()
    const service = makeService(workingProvider, log)
    const seen: { outcome: ProvisioningOutcome; rowsAtCall: number }[] = []
    service.setTeardownRecordedHook(async (record, outcome) => {
      expect(record.id).toBe('env_1')
      seen.push({ outcome, rowsAtCall: rows.length })
    })

    await service.teardown('ws_1', 'env_1')

    expect(seen).toEqual([{ outcome: 'success', rowsAtCall: 2 }])
    expect(rows).toEqual([
      { operation: 'teardown', outcome: 'success' },
      { operation: 'teardown-verify', outcome: 'failure' },
    ])
  })

  it('fires the hook only after the CONFIRMATION row lands, not between the two', async () => {
    // The regression guard for the ordering above, stated as the thing a reader would check: a
    // consumer that re-reads the log the moment it is notified must be able to see the verdict.
    const { rows, log } = fakeLog()
    const service = makeService(probing({ state: 'gone' }), log)
    let rowsWhenNotified: { operation: string; outcome: string }[] = []
    service.setTeardownRecordedHook(async () => {
      rowsWhenNotified = [...rows]
    })

    await service.teardown('ws_1', 'env_1')

    expect(rowsWhenNotified).toContainEqual({
      operation: 'teardown-verify',
      outcome: 'success',
    })
  })

  it('notifies on a FAILED attempt too, and still surfaces the provider error', async () => {
    // Without this edge an environment the provider refuses to reclaim reads on the PR as one
    // nobody has got to yet: a settled run has no step settlement left to re-publish from.
    const { rows, log } = fakeLog()
    const service = makeService(refusingProvider, log)
    const seen: ProvisioningOutcome[] = []
    service.setTeardownRecordedHook(async (_record, outcome) => {
      seen.push(outcome)
    })

    await expect(service.teardown('ws_1', 'env_1')).rejects.toThrow('provider refused')

    expect(seen).toEqual(['failure'])
    expect(rows).toEqual([{ operation: 'teardown', outcome: 'failure' }])
  })

  it('never lets a failing hook break the teardown it is reporting on', async () => {
    const { log } = fakeLog()
    const service = makeService(workingProvider, log)
    service.setTeardownRecordedHook(async () => {
      throw new Error('the report publisher is down')
    })

    await expect(service.teardown('ws_1', 'env_1')).resolves.toMatchObject({
      handle: { id: 'env_1' },
    })
  })
})

// The teardown CONFIRMATION. A provider call that returns without throwing is not an environment
// being gone: the generic manifest provider destroys nothing when its manifest omits a
// `teardown:` request and still reports `torn_down`, and a namespace DELETE returns while the
// namespace is still Terminating. These pin that only a positive probe is read as a reclaim, and
// that each way of failing to prove one stays its own answer.

/** A provider whose probe returns whatever the test needs. */
function probing(probe: TeardownProbe): EnvironmentProvider {
  return {
    async teardown() {
      return { status: 'torn_down' }
    },
    async confirmTeardown() {
      return probe
    },
  } as unknown as EnvironmentProvider
}

describe('EnvironmentTeardownService teardown confirmation', () => {
  it('confirms only when the probe positively finds the environment gone', async () => {
    const { rows, log } = fakeLog()
    const service = makeService(probing({ state: 'gone' }), log)

    const result = await service.teardown('ws_1', 'env_1')

    expect(result.confirmation).toBe('confirmed')
    expect(result.reason).toBeNull()
    expect(rows).toContainEqual({ operation: 'teardown-verify', outcome: 'success' })
  })

  it('reports a still-running environment as still_standing, not as a reclaim', async () => {
    // The headline case: a no-op teardown. The provider said yes and destroyed nothing, so the
    // environment is up, billing, and — before the probe — reported on the PR as torn down.
    const { rows, log } = fakeLog()
    const service = makeService(
      probing({ state: 'present', terminating: false, detail: 'still Active' }),
      log,
    )

    const result = await service.teardown('ws_1', 'env_1')

    expect(result.confirmation).toBe('still_standing')
    expect(result.reason).toContain('still Active')
    expect(rows).toContainEqual({ operation: 'teardown-verify', outcome: 'failure' })
  })

  it('keeps a TERMINATING environment apart from one that never went away', async () => {
    // A namespace draining its finalizers will confirm on a later pass; an Active one never
    // will. Same probe state, opposite advice, so they must not share a verdict.
    const service = makeService(probing({ state: 'present', terminating: true }), fakeLog().log)

    expect((await service.teardown('ws_1', 'env_1')).confirmation).toBe('unconfirmed')
  })

  it('separates a PERMANENT inability to verify from a transient one', async () => {
    // A manifest with no `status:` request answers identically forever and is fixed by a human
    // editing it; an apiserver that refused one read may well answer the next. An operator
    // waiting on the first for a confirmation that is never coming is the failure here.
    const permanent = makeService(
      probing({ state: 'unknown', retryable: false, reason: 'no status request declared' }),
      fakeLog().log,
    )
    const transient = makeService(
      probing({ state: 'unknown', retryable: true, reason: 'apiserver timed out' }),
      fakeLog().log,
    )

    expect((await permanent.teardown('ws_1', 'env_1')).confirmation).toBe('unverifiable')
    expect((await transient.teardown('ws_1', 'env_1')).confirmation).toBe('unconfirmed')
  })

  it('treats a provider that cannot verify as unverifiable, never as confirmed', async () => {
    // `workingProvider` implements no `confirmTeardown`. Silence about an environment is not
    // evidence of its death — this is the inversion the whole change rests on.
    const service = makeService(workingProvider, fakeLog().log)

    const result = await service.teardown('ws_1', 'env_1')

    expect(result.confirmation).toBe('unverifiable')
    expect(result.reason).toContain('cannot confirm')
  })

  it('does not let a THROWING probe undo a teardown that succeeded', async () => {
    // The teardown worked and the record is tombstoned; the probe only adds knowledge, so its
    // worst case is the absence of knowledge rather than a failed teardown.
    const provider = {
      async teardown() {
        return { status: 'torn_down' }
      },
      async confirmTeardown(): Promise<never> {
        throw new Error('probe exploded')
      },
    } as unknown as EnvironmentProvider
    const service = makeService(provider, fakeLog().log)

    const result = await service.teardown('ws_1', 'env_1')

    expect(result.confirmation).toBe('unconfirmed')
    expect(result.reason).toContain('probe exploded')
  })

  it('records no confirmation row when the teardown itself failed', async () => {
    // There is nothing to confirm about a destroy the provider refused, and writing a verify
    // failure beside the teardown failure would double-count one stuck environment.
    const { rows, log } = fakeLog()
    const service = makeService(refusingProvider, log)

    await expect(service.teardown('ws_1', 'env_1')).rejects.toThrow('provider refused')

    expect(rows).toEqual([{ operation: 'teardown', outcome: 'failure' }])
  })

  it('stops waiting on a probe that never answers, without losing the teardown', async () => {
    // `confirmTeardown` is a PUBLIC port: the built-ins bound their own transports, a
    // deployment's own provider need not. The teardown already succeeded and is on record, so an
    // unresponsive provider must cost only the confirmation — never the HTTP request an
    // on-demand teardown is holding open, nor the rest of a TTL sweep pass behind it.
    vi.useFakeTimers()
    try {
      const { rows, log } = fakeLog()
      const provider = {
        async teardown() {
          return { status: 'torn_down' }
        },
        confirmTeardown: () => new Promise<never>(() => {}),
      } as unknown as EnvironmentProvider
      const settled = makeService(provider, log).teardown('ws_1', 'env_1')
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await settled

      // `unconfirmed`, not `unverifiable`: a provider that timed out may answer next sweep, where
      // one with no probe at all never will.
      expect(result.confirmation).toBe('unconfirmed')
      expect(result.reason).toContain('did not answer')
      expect(rows).toEqual([
        { operation: 'teardown', outcome: 'success' },
        { operation: 'teardown-verify', outcome: 'failure' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to interpret a probe state this build does not define', async () => {
    // Same public-port reasoning: the union is not the platform's to trust. Falling off the
    // switch would return `undefined` as the verdict, which reads as neither a reclaim nor a
    // refusal to say — the one outcome worse than an honest "could not verify".
    const service = makeService(
      probing({ state: 'evaporated' } as unknown as TeardownProbe),
      fakeLog().log,
    )

    const result = await service.teardown('ws_1', 'env_1')

    expect(result.confirmation).toBe('unconfirmed')
    expect(result.reason).toContain('does not recognise')
  })
})

describe('EnvironmentTeardownService org-secret delegation', () => {
  // The provisioning service seals `provisionFieldsCipher` through the SAME `OrgSecretCipher`
  // seam, so a node holding a delegate for one half and not the other is the specific breakage
  // this pins: it stands infrastructure up under the mothership's key and then cannot open the
  // fields its own teardown needs, failing before `provider.teardown` on every mothership-sealed
  // row. A local-cipher fallback would be worse than the failure, so the assertion is that the
  // delegate is used EXCLUSIVELY, and addressed by ROW.
  const SEALED: EnvironmentRecord = {
    ...RECORD,
    provisionFieldsCipher: 'sealed-by-the-mothership',
  }

  function delegatingService(delegate: SecretDelegate, provider: EnvironmentProvider) {
    const connectionService = {
      resolveProviderForRecord: async () => ({
        provider,
        manifest: MANIFEST,
        resolveSecret: () => undefined,
      }),
    } as unknown as EnvironmentConnectionService
    return new EnvironmentTeardownService({
      connectionService,
      environmentRegistryRepository: fakeRegistry(SEALED),
      // The LOCAL key, which on a mothership-mode node cannot open this row at all. Present so a
      // fallback would show up as a pass rather than as the throw below.
      secretCipher: {
        encrypt: async () => 'local',
        decrypt: async () => {
          throw new Error('local key cannot open a mothership-sealed row')
        },
      },
      secretDelegate: delegate,
      clock: { now: () => 2_000 },
      provisioningLog: fakeLog().log,
    })
  }

  it('opens the provision fields through the mothership, addressed by row', async () => {
    const refs: DelegatedSecretRef[] = []
    const delegate: SecretDelegate = {
      async unseal(ref) {
        refs.push(ref)
        return JSON.stringify({ stackId: 'stk_9' })
      },
      async seal() {
        throw new Error('teardown never seals')
      },
    }
    let sawFields: unknown
    const provider = {
      async teardown(request: { provisionFields: unknown }) {
        sawFields = request.provisionFields
        return { status: 'torn_down' }
      },
    } as unknown as EnvironmentProvider

    await delegatingService(delegate, provider).teardown('ws_1', 'env_1')

    // The ROW, never the envelope: the mothership re-reads it under the node's account scope, so
    // the ref has to carry the workspace and the environment id in the source's declared arity.
    expect(refs).toEqual([
      {
        source: 'environment_provision_fields',
        workspaceId: 'ws_1',
        key: ['env_1'],
      },
    ])
    expect(sawFields).toEqual({ stackId: 'stk_9' })
  })

  it('fails the teardown when the mothership cannot answer, rather than tearing down blind', async () => {
    // An unreachable mothership and a row holding no provision fields are opposite facts. Calling
    // `provider.teardown` with `{}` would ask the provider to reclaim an environment described by
    // nothing, and a provider that shrugged at that would have the record tombstoned behind it.
    const delegate: SecretDelegate = {
      async unseal(): Promise<never> {
        throw new Error('mothership unreachable')
      },
      async seal(): Promise<never> {
        throw new Error('teardown never seals')
      },
    }
    const provider = {
      async teardown(): Promise<never> {
        throw new Error('provider must never be reached')
      },
    } as unknown as EnvironmentProvider

    await expect(delegatingService(delegate, provider).teardown('ws_1', 'env_1')).rejects.toThrow(
      'mothership unreachable',
    )
  })
})
