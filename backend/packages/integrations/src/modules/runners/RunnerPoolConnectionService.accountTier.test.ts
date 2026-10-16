import {
  DEFAULT_WORKSPACE_SETTINGS,
  type AccountRunnerPoolRecord,
  type AccountRunnerPoolRepository,
  type RunnerPoolConnectionRecord,
  type RunnerPoolConnectionRepository,
  type SecretCipher,
  type WorkspaceRepository,
  type WorkspaceSettings,
  type WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { RunnerPoolConnectionService } from './RunnerPoolConnectionService.js'
import { defaultRunnerBackendRegistry } from './runner-backends.js'

// The ONE dispatch resolver: the board's own live row, else its account's row, else nothing, with
// the board-side marker and the legacy-board rule deciding whether the account tier applies. Every
// read of "the board's pool" goes through it, so these assert the answer through the public reads.

const CONFIG = {
  kind: 'kubernetes' as const,
  kubernetes: {
    label: 'Seeded',
    apiServerUrl: 'https://k8s.example:6443',
    namespace: 'cat-factory',
    image: 'ghcr.io/acme/executor:1',
  },
}

const accountRow = (accountId: string): AccountRunnerPoolRecord => ({
  accountId,
  kind: 'kubernetes',
  providerId: 'k8s',
  label: 'Account pool',
  baseUrl: 'https://k8s.example:6443',
  configJson: JSON.stringify(CONFIG),
  secretsCipher: '{"apiToken":"t"}',
  createdAt: 5,
})

const ownRow = (workspaceId: string): RunnerPoolConnectionRecord => ({
  ...accountRow('ignored'),
  workspaceId,
  label: 'Board pool',
  deletedAt: null,
})

function setup(opts: {
  accountId?: string | null
  own?: RunnerPoolConnectionRecord | null
  account?: AccountRunnerPoolRecord | null
  inherit?: boolean
  wired?: boolean
}) {
  const inserted: AccountRunnerPoolRecord[] = []
  const service = new RunnerPoolConnectionService({
    runnerPoolConnectionRepository: {
      getByWorkspace: async () => opts.own ?? null,
    } as unknown as RunnerPoolConnectionRepository,
    workspaceRepository: {
      get: async () => ({ id: 'ws_1' }),
      accountOf: async () => (opts.accountId === undefined ? 'acc_1' : opts.accountId),
    } as unknown as WorkspaceRepository,
    secretCipher: {
      encrypt: async (v: string) => v,
      decrypt: async (v: string) => v,
    } as SecretCipher,
    clock: { now: () => 1_000 },
    runnerBackendRegistry: defaultRunnerBackendRegistry(),
    ...(opts.wired === false
      ? {}
      : {
          accountRunnerPool: {
            repository: {
              getByAccount: async () => opts.account ?? null,
              insertIfAbsent: async (record: AccountRunnerPoolRecord) => {
                inserted.push(record)
                return true
              },
            } as unknown as AccountRunnerPoolRepository,
            workspaceSettingsRepository: {
              get: async (): Promise<WorkspaceSettings | null> =>
                opts.inherit === undefined
                  ? null
                  : { ...DEFAULT_WORKSPACE_SETTINGS, inheritAccountRunnerPool: opts.inherit },
            } as unknown as WorkspaceSettingsRepository,
          },
        }),
  })
  return { service, inserted }
}

describe('RunnerPoolConnectionService account tier', () => {
  it('falls back to the account pool for a board with none of its own', async () => {
    const { service } = setup({ account: accountRow('acc_1') })

    expect((await service.getConnection('ws_1'))?.label).toBe('Account pool')
    expect(await service.hasConnection('ws_1')).toBe(true)
    expect((await service.resolve('ws_1'))?.kind).toBe('kubernetes')
  })

  it("prefers the board's own live row over the account's", async () => {
    const { service } = setup({ own: ownRow('ws_1'), account: accountRow('acc_1') })

    expect((await service.getConnection('ws_1'))?.label).toBe('Board pool')
  })

  it('answers nothing when the account has no pool', async () => {
    const { service } = setup({ account: null })

    expect(await service.getConnection('ws_1')).toBeNull()
    expect(await service.resolve('ws_1')).toBeNull()
  })

  it('answers nothing for a legacy board with no account, even if some account has a pool', async () => {
    const { service } = setup({ accountId: null, account: accountRow('acc_1') })

    expect(await service.hasConnection('ws_1')).toBe(false)
  })

  it('stops at the explicit "none" marker', async () => {
    const { service } = setup({ account: accountRow('acc_1'), inherit: false })

    expect(await service.hasConnection('ws_1')).toBe(false)
    expect(await service.resolve('ws_1')).toBeNull()
  })

  it('inherits by default when the board has no settings row yet', async () => {
    const { service } = setup({ account: accountRow('acc_1'), inherit: undefined })

    expect(await service.hasConnection('ws_1')).toBe(true)
  })

  it('behaves as before when the account tier is not wired', async () => {
    const { service } = setup({ account: accountRow('acc_1'), wired: false })

    expect(await service.hasConnection('ws_1')).toBe(false)
  })

  it('refuses to rotate secrets on an inherited pool, which would fork the board off the account', async () => {
    const { service } = setup({ account: accountRow('acc_1') })

    await expect(service.updateSecrets('ws_1', { apiToken: 'x' })).rejects.toMatchObject({
      code: 'conflict',
    })
  })
})

describe('RunnerPoolConnectionService seeding an account', () => {
  it('validates like a registration: a missing referenced secret is refused', async () => {
    const { service, inserted } = setup({})

    await expect(service.seedAccount('acc_1', { config: CONFIG, secrets: {} })).rejects.toThrow(
      /Missing secret values/,
    )
    expect(inserted).toEqual([])
  })

  it('refuses an unregistered backend kind', async () => {
    const { service } = setup({})

    await expect(
      service.seedAccount('acc_1', {
        config: { kind: 'nomad' } as never,
        secrets: {},
      }),
    ).rejects.toThrow(/Unknown runner backend kind/)
  })

  it('seals and inserts a valid seed for the account', async () => {
    const { service, inserted } = setup({})

    expect(await service.seedAccount('acc_1', { config: CONFIG, secrets: { apiToken: 't' } })).toBe(
      true,
    )

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ accountId: 'acc_1', kind: 'kubernetes', createdAt: 1_000 })
  })
})
