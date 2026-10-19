import { describe, expect, it, vi } from 'vitest'
import {
  createRecordingLogger,
  ValidationError,
  type AccountRecord,
  type AccountRunnerPoolRecord,
} from '@cat-factory/kernel'
import { createRunnerPoolSeeder, type RunnerPoolSeed } from './RunnerPoolSeeder.js'

// The seeder decides WHICH accounts get a pool and how a failure is reported. Registration itself
// (validation, sealing, the insert) is the connection service's, covered by its own suite, so the
// fakes below are just the calls the seeder makes.

const seed: RunnerPoolSeed = {
  config: {
    kind: 'kubernetes',
    kubernetes: {
      label: 'Seeded',
      apiServerUrl: 'https://k8s.example:6443',
      namespace: 'cat-factory',
      image: 'ghcr.io/acme/executor:1',
    },
  } as RunnerPoolSeed['config'],
  secrets: { apiToken: 'seed-token' },
}

const account = (id: string, type: AccountRecord['type'] = 'org'): AccountRecord => ({
  id,
  type,
  name: id,
  githubAccountLogin: null,
  ownerUserId: type === 'personal' ? `user-${id}` : null,
  createdAt: 1,
})

function setup(opts: {
  accounts?: AccountRecord[]
  seeded?: string[]
  seedSource?: Parameters<typeof createRunnerPoolSeeder>[0]['seedSource']
  seedAccount?: (accountId: string) => Promise<boolean>
  reseedAccount?: (current: AccountRunnerPoolRecord) => Promise<boolean>
}) {
  const accounts = opts.accounts ?? [account('acc-a'), account('acc-b', 'personal')]
  const seeded = new Set(opts.seeded ?? [])
  const connectionService = {
    seedAccount: vi.fn(opts.seedAccount ?? (async () => true)),
    reseedAccount: vi.fn(opts.reseedAccount ?? (async () => false)),
  }
  const accountRepository = {
    get: vi.fn(async (id: string) => accounts.find((a) => a.id === id) ?? null),
    listAll: vi.fn(async () => accounts),
  }
  const accountRunnerPoolRepository = {
    getByAccount: vi.fn(async (id: string) =>
      seeded.has(id) ? ({ accountId: id } as AccountRunnerPoolRecord) : null,
    ),
    listByAccounts: vi.fn(async (ids: string[]) =>
      ids
        .filter((id) => seeded.has(id))
        .map((id) => ({ accountId: id }) as AccountRunnerPoolRecord),
    ),
  }
  const logger = createRecordingLogger()
  const seeder = createRunnerPoolSeeder({
    connectionService,
    accountRepository,
    accountRunnerPoolRepository,
    seedSource: opts.seedSource ?? (() => seed),
    logger,
  })
  return { seeder, connectionService, accountRepository, accountRunnerPoolRepository, logger }
}

describe('createRunnerPoolSeeder.ensureForAccount', () => {
  it('seeds an account that has no pool, passing the account to the callback', async () => {
    const seedSource = vi.fn(() => seed)
    const { seeder, connectionService } = setup({ seedSource })

    await seeder.ensureForAccount('acc-b')

    expect(seedSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acc-b', type: 'personal' }),
    )
    expect(connectionService.seedAccount).toHaveBeenCalledWith('acc-b', seed)
  })

  it('leaves an account that already has a pool alone, without calling the callback', async () => {
    const seedSource = vi.fn(() => seed)
    const { seeder, connectionService } = setup({ seeded: ['acc-a'], seedSource })

    await seeder.ensureForAccount('acc-a')

    expect(seedSource).not.toHaveBeenCalled()
    expect(connectionService.seedAccount).not.toHaveBeenCalled()
    // Board creation never replaces: a replica on the previous seed would write it back.
    expect(connectionService.reseedAccount).not.toHaveBeenCalled()
  })

  it('does nothing for a legacy board with no account', async () => {
    const { seeder, accountRunnerPoolRepository } = setup({})

    await seeder.ensureForAccount(null)

    expect(accountRunnerPoolRepository.getByAccount).not.toHaveBeenCalled()
  })

  it('seeds nothing when the callback declares no pool for the account', async () => {
    const { seeder, connectionService, logger } = setup({ seedSource: () => undefined })

    await seeder.ensureForAccount('acc-a')

    expect(connectionService.seedAccount).not.toHaveBeenCalled()
    expect(logger.lines.filter((l) => l.level === 'error')).toEqual([])
  })

  it('swallows a failed read so board creation cannot fail on it, and says so at warn', async () => {
    const { seeder, accountRunnerPoolRepository, logger } = setup({})
    accountRunnerPoolRepository.getByAccount.mockRejectedValueOnce(new Error('store down'))

    await expect(seeder.ensureForAccount('acc-a')).resolves.toBeUndefined()

    expect(logger.lines.find((l) => l.level === 'warn')?.fields).toMatchObject({
      accountId: 'acc-a',
    })
  })
})

describe('createRunnerPoolSeeder bad seeds are loud', () => {
  it('reports an output that is not a runner pool at error, naming the account', async () => {
    const { seeder, connectionService, logger } = setup({
      seedSource: () => ({ config: { kind: 42 }, secrets: {} }) as unknown as RunnerPoolSeed,
    })

    await seeder.ensureForAccount('acc-a')

    expect(connectionService.seedAccount).not.toHaveBeenCalled()
    const error = logger.lines.find((l) => l.level === 'error')
    expect(error?.msg).toBe('declared runner pool is not a valid runner pool')
    expect(error?.fields).toMatchObject({ accountId: 'acc-a' })
  })

  it('reports a backend refusal (unknown kind, unsafe URL, missing secret) at error', async () => {
    const { seeder, logger } = setup({
      seedAccount: async () => {
        throw new ValidationError("Unknown runner backend kind: 'nomad'")
      },
    })

    await seeder.ensureForAccount('acc-a')

    const error = logger.lines.find((l) => l.level === 'error')
    expect(error?.msg).toBe('declared runner pool was refused for account')
    expect(error?.fields).toMatchObject({ accountId: 'acc-a' })
  })

  it('reports a throwing callback at error', async () => {
    const { seeder, logger } = setup({
      seedSource: () => {
        throw new Error('lookup failed')
      },
    })

    await seeder.ensureForAccount('acc-a')

    expect(logger.lines.some((l) => l.level === 'error')).toBe(true)
  })
})

describe('createRunnerPoolSeeder.ensureForAllAccounts', () => {
  it('inserts for accounts without a pool and reconciles the rest, over ONE account read and ONE pool read', async () => {
    const accounts = [account('acc-a'), account('acc-b', 'personal'), account('acc-c')]
    const { seeder, connectionService, accountRepository, accountRunnerPoolRepository } = setup({
      accounts,
      seeded: ['acc-b'],
    })

    await seeder.ensureForAllAccounts()

    expect(connectionService.seedAccount.mock.calls.map(([id]) => id)).toEqual(['acc-a', 'acc-c'])
    expect(connectionService.reseedAccount.mock.calls).toEqual([[{ accountId: 'acc-b' }, seed]])
    expect(accountRepository.listAll).toHaveBeenCalledTimes(1)
    expect(accountRunnerPoolRepository.listByAccounts).toHaveBeenCalledTimes(1)
    expect(accountRunnerPoolRepository.getByAccount).not.toHaveBeenCalled()
  })

  it('logs a replaced pool, and stays quiet when the stored pool already matches', async () => {
    const { seeder, logger } = setup({
      accounts: [account('acc-a'), account('acc-b')],
      seeded: ['acc-a', 'acc-b'],
      reseedAccount: async (current) => current.accountId === 'acc-a',
    })

    await seeder.ensureForAllAccounts()

    const infos = logger.lines.filter((l) => l.level === 'info')
    expect(infos.map((l) => [l.msg, l.fields?.accountId])).toEqual([
      ['replaced account runner pool with the changed seed', 'acc-a'],
    ])
  })

  it('leaves an existing pool in place when the callback no longer declares one', async () => {
    const { seeder, connectionService } = setup({
      accounts: [account('acc-a')],
      seeded: ['acc-a'],
      seedSource: () => undefined,
    })

    await seeder.ensureForAllAccounts()

    expect(connectionService.reseedAccount).not.toHaveBeenCalled()
  })

  it('reports a refused reseed at error, naming the account', async () => {
    const { seeder, logger } = setup({
      accounts: [account('acc-a')],
      seeded: ['acc-a'],
      reseedAccount: async () => {
        throw new ValidationError('Missing secret values for: apiToken')
      },
    })

    await seeder.ensureForAllAccounts()

    expect(logger.lines.find((l) => l.level === 'error')?.fields).toMatchObject({
      accountId: 'acc-a',
    })
  })

  it('keeps going past one bad account and reports it', async () => {
    const { seeder, connectionService, logger } = setup({
      seedAccount: vi
        .fn<(id: string) => Promise<boolean>>()
        .mockRejectedValueOnce(new Error('refused'))
        .mockResolvedValue(true),
    })

    await seeder.ensureForAllAccounts()

    expect(connectionService.seedAccount).toHaveBeenCalledTimes(2)
    expect(logger.lines.filter((l) => l.level === 'error')).toHaveLength(1)
  })

  it('does not throw when the enumeration itself fails', async () => {
    const { seeder, accountRepository, logger } = setup({})
    accountRepository.listAll.mockRejectedValueOnce(new Error('db gone'))

    await expect(seeder.ensureForAllAccounts()).resolves.toBeUndefined()

    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true)
  })
})
