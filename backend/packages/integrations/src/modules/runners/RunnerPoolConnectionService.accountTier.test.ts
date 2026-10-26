import {
  createRecordingLogger,
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
  const replaced: AccountRunnerPoolRecord[] = []
  const logger = createRecordingLogger()
  const service = new RunnerPoolConnectionService({
    logger,
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
              replace: async (record: AccountRunnerPoolRecord) => {
                replaced.push(record)
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
  return { service, inserted, replaced, logger }
}

describe('RunnerPoolConnectionService dispatch readiness', () => {
  it('is ready on an inherited account pool whose kind is registered', async () => {
    const { service } = setup({ account: accountRow('acc_1') })

    expect(await service.dispatchReadiness('ws_1')).toEqual({ state: 'ready' })
  })

  it('names a stored kind the registry no longer has, where resolve answers null', async () => {
    const { service } = setup({ account: { ...accountRow('acc_1'), kind: 'nomad' } })

    expect(await service.dispatchReadiness('ws_1')).toEqual({
      state: 'unknown_kind',
      kind: 'nomad',
    })
    expect(await service.resolve('ws_1')).toBeNull()
  })

  it('tells a board that declined its account pool apart from one with no pool anywhere', async () => {
    const declined = setup({ account: accountRow('acc_1'), inherit: false })
    const nothing = setup({ account: null })

    expect(await declined.service.dispatchReadiness('ws_1')).toEqual({ state: 'inheritance_off' })
    expect(await nothing.service.dispatchReadiness('ws_1')).toEqual({ state: 'none' })
  })

  it('answers none without an account tier, even for an account with a pool', async () => {
    const { service } = setup({ account: accountRow('acc_1'), wired: false })

    expect(await service.dispatchReadiness('ws_1')).toEqual({ state: 'none' })
  })
})

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

describe('RunnerPoolConnectionService reseeding an account', () => {
  // The fake cipher is the identity, so a stored row's `secretsCipher` is the plaintext JSON.
  const stored = (secrets: Record<string, string>, config: unknown = CONFIG) => ({
    ...accountRow('acc_1'),
    configJson: JSON.stringify(config),
    secretsCipher: JSON.stringify(secrets),
  })

  it('leaves a row alone when config and secrets match, whatever the key order', async () => {
    const { service, replaced } = setup({})
    const reordered = { kubernetes: CONFIG.kubernetes, kind: CONFIG.kind }

    expect(
      await service.reseedAccount(stored({ apiToken: 't' }, reordered), {
        config: CONFIG,
        secrets: { apiToken: 't' },
      }),
    ).toBe(false)

    expect(replaced).toEqual([])
  })

  it('replaces the row when a secret was rotated', async () => {
    const { service, replaced } = setup({})

    expect(
      await service.reseedAccount(stored({ apiToken: 'old' }), {
        config: CONFIG,
        secrets: { apiToken: 'new' },
      }),
    ).toBe(true)

    expect(replaced).toHaveLength(1)
    expect(JSON.parse(replaced[0]!.secretsCipher)).toEqual({ apiToken: 'new' })
  })

  it('replaces the row when the config changed', async () => {
    const { service, replaced } = setup({})
    const newImage = {
      ...CONFIG,
      kubernetes: { ...CONFIG.kubernetes, image: 'ghcr.io/acme/executor:2' },
    }

    await service.reseedAccount(stored({ apiToken: 't' }), {
      config: newImage,
      secrets: { apiToken: 't' },
    })

    expect(JSON.parse(replaced[0]!.configJson)).toEqual(newImage)
  })

  it('replaces a row whose stored secrets no longer decrypt, and says so at warn', async () => {
    const { service, replaced, logger } = setup({})

    expect(
      await service.reseedAccount(
        { ...stored({}), secretsCipher: 'not json' },
        {
          config: CONFIG,
          secrets: { apiToken: 't' },
        },
      ),
    ).toBe(true)

    expect(replaced).toHaveLength(1)
    expect(logger.lines.find((l) => l.level === 'warn')?.fields).toMatchObject({
      accountId: 'acc_1',
    })
  })

  it('validates the seed before touching the row', async () => {
    const { service, replaced } = setup({})

    await expect(
      service.reseedAccount(stored({ apiToken: 'old' }), { config: CONFIG, secrets: {} }),
    ).rejects.toThrow(/Missing secret values/)
    expect(replaced).toEqual([])
  })
})
