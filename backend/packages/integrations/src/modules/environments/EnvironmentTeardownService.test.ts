import { describe, expect, it } from 'vitest'
import type {
  EnvironmentProvider,
  EnvironmentRecord,
  EnvironmentRegistryRepository,
  ProvisioningOutcome,
  SecretCipher,
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
  it('notifies AFTER the success row lands, so a consumer re-reading the log sees it', async () => {
    const { rows, log } = fakeLog()
    const service = makeService(workingProvider, log)
    const seen: { outcome: ProvisioningOutcome; rowsAtCall: number }[] = []
    service.setTeardownRecordedHook(async (record, outcome) => {
      expect(record.id).toBe('env_1')
      seen.push({ outcome, rowsAtCall: rows.length })
    })

    await service.teardown('ws_1', 'env_1')

    expect(seen).toEqual([{ outcome: 'success', rowsAtCall: 1 }])
    expect(rows).toEqual([{ operation: 'teardown', outcome: 'success' }])
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

    await expect(service.teardown('ws_1', 'env_1')).resolves.toMatchObject({ id: 'env_1' })
  })
})
