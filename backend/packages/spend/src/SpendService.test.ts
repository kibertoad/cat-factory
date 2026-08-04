import { describe, expect, it, vi } from 'vitest'
import type {
  AccountRepository,
  Clock,
  GroupCacheHandle,
  IdGenerator,
  TokenUsageRecord,
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

describe('SpendService.periodUsage', () => {
  it('resolves ONE period for both aggregates, even across a clock tick', async () => {
    // Why the method exists. `status` and `usageBreakdown` each derive their own period from the
    // clock, so serving the public `GET /api/v1/usage` from both would pair a budget from one
    // period with a breakdown from the next for any request straddling the month roll — the exact
    // skew that serving them as ONE resource is meant to prevent. A clock that advances on every
    // read is what makes the difference observable at all: here both queries must still see the
    // same `periodStart`, and it must be the one the response reports.
    const seen: number[] = []
    let ticks = 0
    const tokenUsageRepository = {
      record: async () => {},
      totalsSinceForWorkspace: async (_ws: string, since: number) => {
        seen.push(since)
        return zeroTotals
      },
      totalsSinceForAccount: async () => zeroTotals,
      totalsSinceForUser: async () => zeroTotals,
      usageBreakdownForWorkspace: async (_ws: string, since: number) => {
        seen.push(since)
        return []
      },
    } as unknown as TokenUsageRepository

    const svc = new SpendService({
      tokenUsageRepository,
      idGenerator,
      // Every `now()` lands in a different month, so a second derivation could not agree.
      clock: { now: () => Date.UTC(2026, ticks++, 15) },
      pricing: DEFAULT_SPEND_PRICING,
    })

    const usage = await svc.periodUsage('ws_a')
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
    expect(usage.periodStart).toBe(seen[0])
  })
})

describe('SpendService.record — per-class pricing', () => {
  function recordingRepo(): { repo: TokenUsageRepository; rows: TokenUsageRecord[] } {
    const rows: TokenUsageRecord[] = []
    return {
      rows,
      repo: {
        record: async (row: TokenUsageRecord) => {
          rows.push(row)
        },
        totalsSinceForWorkspace: async () => zeroTotals,
        totalsSinceForAccount: async () => zeroTotals,
        totalsSinceForUser: async () => zeroTotals,
        usageBreakdownForWorkspace: async () => [],
      } as unknown as TokenUsageRepository,
    }
  }

  const service = (repo: TokenUsageRepository) =>
    new SpendService({
      tokenUsageRepository: repo,
      idGenerator,
      clock,
      pricing: DEFAULT_SPEND_PRICING,
    })

  it('prices a cache read far below fresh input instead of at the fresh rate', async () => {
    // The #1261 shape: a run that is almost entirely cache reads. Metering its whole input at
    // the fresh rate is what made such a run exhaust a budget it had barely touched.
    const { repo, rows } = recordingRepo()
    const cost = await service(repo).record({
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      model: 'anthropic:claude-opus-5',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      inputClasses: { promptTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
    })
    // 1M cache reads at 0.1x the 4.6/Mtok input rate.
    expect(cost).toBeCloseTo(0.46, 6)
    expect(rows[0]?.costEstimate).toBeCloseTo(0.46, 6)
    // The stored VOLUME is unchanged — only what it costs moved.
    expect(rows[0]?.inputTokens).toBe(1_000_000)
  })

  it('prices a cache write ABOVE fresh input', async () => {
    const { repo, rows } = recordingRepo()
    await service(repo).record({
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      model: 'anthropic:claude-opus-5',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      inputClasses: { promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 },
    })
    // 1.25x 4.6. Lumping writes in with reads would have said 0.46 — a 12x under-count on
    // the DEAREST class, which is exactly why the two are kept apart.
    expect(rows[0]?.costEstimate).toBeCloseTo(5.75, 6)
  })

  it('falls back to the fresh rate for a producer that reports no split', async () => {
    // Absent classes are not zeroed classes: the row is priced entirely as fresh, which
    // OVER-states a cached call. That direction is deliberate — a budget safeguard that
    // undercounts stops safeguarding.
    const { repo, rows } = recordingRepo()
    await service(repo).record({
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      model: 'anthropic:claude-opus-5',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    })
    expect(rows[0]?.costEstimate).toBeCloseTo(4.6, 6)
  })
})
