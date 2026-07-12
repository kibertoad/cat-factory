import { describe, expect, it, vi } from 'vitest'
import type {
  AccountRepository,
  Clock,
  GroupCacheHandle,
  IdGenerator,
  TokenUsageRepository,
  UserSettingsRepository,
  WorkspaceSettings,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { SpendService } from './SpendService.js'
import { DEFAULT_SPEND_PRICING } from './pricing.js'

// A minimal in-memory GroupCacheHandle standing in for an AppCaches slice: read-through
// `get` (dedup by group+key) + `invalidate`. Enough to prove SpendService reads its
// slow-moving reads through the handle and drops the right entry on invalidation.
function fakeCache<T>(): GroupCacheHandle<T> {
  const store = new Map<string, T>()
  const k = (key: string, group: string) => `${group}::${key}`
  return {
    async get(key, group, load) {
      const id = k(key, group)
      const hit = store.get(id)
      if (hit !== undefined) return hit
      const value = await load()
      store.set(id, value)
      return value
    },
    async invalidate(key, group) {
      store.delete(k(key, group))
    },
    async invalidateGroup(group) {
      for (const id of store.keys()) if (id.startsWith(`${group}::`)) store.delete(id)
    },
    async invalidateAll() {
      store.clear()
    },
  }
}

const clock: Clock = { now: () => 0 }
const idGenerator: IdGenerator = { next: () => 'tok_x' }
const zeroTotals = { inputTokens: 0, outputTokens: 0, costEstimate: 0 }

function fakeTokenUsage(): TokenUsageRepository {
  return {
    record: async () => {},
    totalsSinceForWorkspace: async () => zeroTotals,
    totalsSinceForAccount: async () => zeroTotals,
    totalsSinceForUser: async () => zeroTotals,
    usageBreakdownForWorkspace: async () => [],
  } as unknown as TokenUsageRepository
}

function workspaceSettings(overrides: Partial<WorkspaceSettings>): WorkspaceSettings {
  return { ...DEFAULT_WORKSPACE_SETTINGS, ...overrides }
}

describe('SpendService pricing read-through (workspaceSettings slice)', () => {
  it('reads the settings row through the cache, and an invalidation re-reads it', async () => {
    let stored: WorkspaceSettings = workspaceSettings({ spendMonthlyLimit: 200 })
    const workspaceSettingsRepository = {
      get: vi.fn(async () => stored),
    } as unknown as WorkspaceSettingsRepository
    const workspaceSettingsCache = fakeCache<{ settings: WorkspaceSettings | null }>()

    const svc = new SpendService({
      tokenUsageRepository: fakeTokenUsage(),
      idGenerator,
      clock,
      pricing: DEFAULT_SPEND_PRICING,
      workspaceSettingsRepository,
      workspaceSettingsCache,
    })

    expect((await svc.status('ws_a')).costLimit).toBe(200)
    // Second read is served from the cache — no second repository hit.
    expect((await svc.status('ws_a')).costLimit).toBe(200)
    expect(workspaceSettingsRepository.get).toHaveBeenCalledTimes(1)

    // A settings write (the real invalidator is WorkspaceSettingsService.update, sharing
    // this slice) drops the entry, so the next read reflects the new budget.
    stored = workspaceSettings({ spendMonthlyLimit: 500 })
    await workspaceSettingsCache.invalidate('ws_a', 'ws_a')
    expect((await svc.status('ws_a')).costLimit).toBe(500)
    expect(workspaceSettingsRepository.get).toHaveBeenCalledTimes(2)
  })
})

describe('SpendService budget-limit read-through (account/user slices)', () => {
  it('caches the account limit and invalidateAccountLimit re-reads it', async () => {
    let limit: number | null = 300
    const accountRepository = {
      get: vi.fn(async () => ({ spendMonthlyLimit: limit })),
    } as unknown as AccountRepository
    const accountBudgetLimitCache = fakeCache<{ limit: number | null }>()

    const svc = new SpendService({
      tokenUsageRepository: fakeTokenUsage(),
      idGenerator,
      clock,
      pricing: DEFAULT_SPEND_PRICING,
      accountRepository,
      accountBudgetLimitCache,
    })

    expect((await svc.accountStatus('acc_a'))?.costLimit).toBe(300)
    expect((await svc.accountStatus('acc_a'))?.costLimit).toBe(300)
    expect(accountRepository.get).toHaveBeenCalledTimes(1)

    limit = 900
    await svc.invalidateAccountLimit('acc_a')
    expect((await svc.accountStatus('acc_a'))?.costLimit).toBe(900)
    expect(accountRepository.get).toHaveBeenCalledTimes(2)
  })

  it('caches the user limit and invalidateUserLimit re-reads it', async () => {
    let limit: number | null = 40
    const userSettingsRepository = {
      get: vi.fn(async () => ({ spendMonthlyLimit: limit })),
    } as unknown as UserSettingsRepository
    const userBudgetLimitCache = fakeCache<{ limit: number | null }>()

    const svc = new SpendService({
      tokenUsageRepository: fakeTokenUsage(),
      idGenerator,
      clock,
      pricing: DEFAULT_SPEND_PRICING,
      userSettingsRepository,
      userBudgetLimitCache,
    })

    expect((await svc.userStatus('usr_a'))?.costLimit).toBe(40)
    expect((await svc.userStatus('usr_a'))?.costLimit).toBe(40)
    expect(userSettingsRepository.get).toHaveBeenCalledTimes(1)

    limit = 80
    await svc.invalidateUserLimit('usr_a')
    expect((await svc.userStatus('usr_a'))?.costLimit).toBe(80)
    expect(userSettingsRepository.get).toHaveBeenCalledTimes(2)
  })
})
