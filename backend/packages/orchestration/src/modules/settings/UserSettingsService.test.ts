import { describe, expect, it, vi } from 'vitest'
import type { UserSettings } from '@cat-factory/contracts'
import type { UserSettingsRepository } from '@cat-factory/kernel'
import { UserSettingsService } from './UserSettingsService.js'

function fakeRepo(initial: UserSettings | null = null): UserSettingsRepository & {
  readonly stored: UserSettings | null
} {
  let stored = initial
  return {
    get stored() {
      return stored
    },
    async get() {
      return stored
    },
    async upsert(_userId: string, settings: UserSettings) {
      stored = settings
    },
  }
}

describe('UserSettingsService', () => {
  it('returns the built-in default when the user has no row', async () => {
    const svc = new UserSettingsService({ userSettingsRepository: fakeRepo() })
    expect(await svc.get('usr_1')).toEqual({ spendMonthlyLimit: null })
  })

  it('persists an update and invalidates the cached user limit', async () => {
    const repo = fakeRepo()
    const onUserBudgetChanged = vi.fn()
    const svc = new UserSettingsService({ userSettingsRepository: repo, onUserBudgetChanged })
    const next = await svc.update('usr_1', { spendMonthlyLimit: 40 })
    expect(next).toEqual({ spendMonthlyLimit: 40 })
    expect(repo.stored).toEqual({ spendMonthlyLimit: 40 })
    expect(onUserBudgetChanged).toHaveBeenCalledWith('usr_1')
  })

  it('keeps 0 as a real limit (distinct from null)', async () => {
    const repo = fakeRepo()
    const svc = new UserSettingsService({ userSettingsRepository: repo })
    expect(await svc.update('usr_1', { spendMonthlyLimit: 0 })).toEqual({ spendMonthlyLimit: 0 })
  })

  it('rejects a limit above the operator cap and does not persist it', async () => {
    const repo = fakeRepo()
    const onUserBudgetChanged = vi.fn()
    const svc = new UserSettingsService({
      userSettingsRepository: repo,
      onUserBudgetChanged,
      resolveUserBudgetCap: () => 100,
    })
    await expect(svc.update('usr_1', { spendMonthlyLimit: 101 })).rejects.toThrow(
      /exceeds the operator cap/,
    )
    expect(repo.stored).toBeNull()
    expect(onUserBudgetChanged).not.toHaveBeenCalled()
  })

  it('allows a limit at the cap and any limit when uncapped', async () => {
    const atCap = new UserSettingsService({
      userSettingsRepository: fakeRepo(),
      resolveUserBudgetCap: () => 100,
    })
    expect(await atCap.update('usr_1', { spendMonthlyLimit: 100 })).toEqual({
      spendMonthlyLimit: 100,
    })

    const uncapped = new UserSettingsService({
      userSettingsRepository: fakeRepo(),
      resolveUserBudgetCap: () => null,
    })
    expect(await uncapped.update('usr_2', { spendMonthlyLimit: 999999 })).toEqual({
      spendMonthlyLimit: 999999,
    })
  })
})
