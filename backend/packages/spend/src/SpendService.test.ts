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
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        inputClasses: { promptTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
      },
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
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        inputClasses: { promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 },
      },
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

describe('SpendService forecast batching', () => {
  const PERIOD_START = Date.UTC(2026, 6, 1)
  const NOW = PERIOD_START + 10 * 24 * 60 * 60 * 1000

  /** A ledger whose two grouped reads report the same spend for every requested scope. */
  function ledger(scopes: string[], costEstimate: number): TokenUsageRepository {
    const window = new Map(
      scopes.map((id) => [id, { costEstimate, firstSeenAt: PERIOD_START }] as const),
    )
    return {
      ...fakeTokenUsage(),
      meteredSpendByWorkspaceSince: async () => new Map(window),
      meteredSpendByAccountSince: async () => new Map(window),
    } as unknown as TokenUsageRepository
  }

  it('resolves every workspace pricing in ONE batched settings read', async () => {
    // The sweep asks about every workspace in the deployment on every pass, so a point read per
    // workspace here is the banned N+1 (and on the Worker the settings cache is pass-through, so
    // it would be N real round trips). One `listByWorkspaceIds` serves the whole set.
    const workspaceIds = ['ws_1', 'ws_2', 'ws_3']
    const workspaceSettingsRepository = {
      get: vi.fn(async () => null),
      listByWorkspaceIds: vi.fn(
        async (ids: string[]) =>
          new Map(ids.map((id) => [id, workspaceSettings({ spendMonthlyLimit: 200 })])),
      ),
    } as unknown as WorkspaceSettingsRepository

    const svc = new SpendService({
      tokenUsageRepository: ledger(workspaceIds, 180),
      idGenerator,
      clock,
      pricing: DEFAULT_SPEND_PRICING,
      workspaceSettingsRepository,
    })

    const out = await svc.forecastWorkspaces(workspaceIds, NOW)
    expect(out.size).toBe(3)
    // Each workspace's OWN override, not the base table's default limit.
    expect(out.get('ws_1')?.costLimit).toBe(200)
    expect(workspaceSettingsRepository.listByWorkspaceIds).toHaveBeenCalledTimes(1)
    expect(workspaceSettingsRepository.get).not.toHaveBeenCalled()
  })

  it('falls back to the base table for a workspace with no persisted overrides', async () => {
    const workspaceSettingsRepository = {
      get: vi.fn(async () => null),
      // `ws_2` has never been written: absent from the map, not a null entry.
      listByWorkspaceIds: vi.fn(
        async () => new Map([['ws_1', workspaceSettings({ spendMonthlyLimit: 200 })]]),
      ),
    } as unknown as WorkspaceSettingsRepository

    const svc = new SpendService({
      tokenUsageRepository: ledger(['ws_1', 'ws_2'], 180),
      idGenerator,
      clock,
      pricing: DEFAULT_SPEND_PRICING,
      workspaceSettingsRepository,
    })

    const out = await svc.forecastWorkspaces(['ws_1', 'ws_2'], NOW)
    expect(out.get('ws_1')?.costLimit).toBe(200)
    expect(out.get('ws_2')?.costLimit).toBe(DEFAULT_SPEND_PRICING.monthlyLimit)
  })

  const DAY = 24 * 60 * 60 * 1000

  /**
   * A ledger whose two grouped reads answer DIFFERENTLY: the period read is what the result is
   * keyed off, the trailing window read is what the burn rate is derived from. They are the same
   * method at two `since` points, so a fake that ignores the argument cannot tell them apart.
   */
  function windowedLedger(
    period: Record<string, number>,
    window: Record<string, { costEstimate: number; firstSeenAt: number }>,
  ): TokenUsageRepository {
    return {
      ...fakeTokenUsage(),
      meteredSpendByWorkspaceSince: async (_ids: string[], since: number) =>
        since === PERIOD_START
          ? new Map(
              Object.entries(period).map(([id, costEstimate]) => [
                id,
                { costEstimate, firstSeenAt: PERIOD_START },
              ]),
            )
          : new Map(Object.entries(window)),
    } as unknown as TokenUsageRepository
  }

  const forecastOf = async (repo: TokenUsageRepository, ids: string[]) =>
    new SpendService({
      tokenUsageRepository: repo,
      idGenerator,
      clock,
      pricing: DEFAULT_SPEND_PRICING,
    }).forecastWorkspaces(ids, NOW)

  it("derives the rate from the WINDOW's own cost and first-seen stamp", async () => {
    // The two window fields are what turn a period total into a rate, and each has a fallback for
    // the scope that has no window row. A fallback taken while a row exists is silent: the
    // forecast still comes back, just measuring the wrong span, or no spend at all.
    const out = await forecastOf(
      // 120 EUR this period, of which 30 landed in the last two days: 15/day, not 120/7 and not 0.
      windowedLedger({ ws_1: 120 }, { ws_1: { costEstimate: 30, firstSeenAt: NOW - 2 * DAY } }),
      ['ws_1'],
    )
    expect(out.get('ws_1')?.forecast.burnRatePerDay).toBeCloseTo(15)
    expect(out.get('ws_1')?.forecast.confidence).toBe('ok')
    expect(out.get('ws_1')?.costSpent).toBe(120)
  })

  it('forecasts a scope that spent this period but nothing lately as a confident zero', async () => {
    // `ws_2` is in the period read and absent from the window read, which is what "spent early in
    // the month, quiet since" looks like. Its rate is zero, and the absence must be tolerated
    // rather than dereferenced.
    const out = await forecastOf(
      windowedLedger(
        { ws_1: 120, ws_2: 40 },
        { ws_1: { costEstimate: 30, firstSeenAt: NOW - 2 * DAY } },
      ),
      ['ws_1', 'ws_2'],
    )
    expect(out.get('ws_2')?.forecast.burnRatePerDay).toBe(0)
    expect(out.get('ws_2')?.forecast.confidence).toBe('ok')
    expect(out.get('ws_2')?.forecast.projectedTotal).toBe(40)
    expect(out.get('ws_1')?.forecast.burnRatePerDay).toBeGreaterThan(0)
  })

  it('resolves every account limit in ONE batched account read, skipping inactive tiers', async () => {
    const accountRepository = {
      get: vi.fn(async () => null),
      listByIds: vi.fn(async () => [
        { id: 'acc_1', spendMonthlyLimit: 500 },
        // No configured limit and no operator cap: an inactive tier has no ceiling to warn
        // about approaching, so it must not appear in the result at all.
        { id: 'acc_2', spendMonthlyLimit: null },
      ]),
    } as unknown as AccountRepository

    const svc = new SpendService({
      tokenUsageRepository: ledger(['acc_1', 'acc_2'], 450),
      idGenerator,
      clock,
      pricing: DEFAULT_SPEND_PRICING,
      accountRepository,
    })

    const out = await svc.forecastAccounts(['acc_1', 'acc_2'], NOW)
    expect([...out.keys()]).toEqual(['acc_1'])
    expect(out.get('acc_1')?.costLimit).toBe(500)
    expect(accountRepository.listByIds).toHaveBeenCalledTimes(1)
    expect(accountRepository.get).not.toHaveBeenCalled()
  })
})

describe('SpendService tier statuses', () => {
  const NOW = Date.UTC(2026, 6, 17, 9, 30)
  const at = (costEstimate: number) => ({ inputTokens: 100, outputTokens: 50, costEstimate })

  /** A ledger reporting a different period total per tier, so a status cannot read the wrong one. */
  function tieredLedger(totals: { workspace?: number; account?: number; user?: number }) {
    return {
      ...fakeTokenUsage(),
      totalsSinceForWorkspace: async () => at(totals.workspace ?? 0),
      totalsSinceForAccount: async () => at(totals.account ?? 0),
      totalsSinceForUser: async () => at(totals.user ?? 0),
    } as unknown as TokenUsageRepository
  }

  const service = (repo: TokenUsageRepository, pricing = DEFAULT_SPEND_PRICING) =>
    new SpendService({
      tokenUsageRepository: repo,
      idGenerator,
      clock: { now: () => NOW },
      pricing,
    })

  it('reports the workspace period, and counts spend AT the limit as exceeded', async () => {
    const limit = DEFAULT_SPEND_PRICING.monthlyLimit
    const status = await service(tieredLedger({ workspace: limit })).status('ws')
    expect(status.periodStart).toBe(Date.UTC(2026, 6, 1))
    expect(status.costSpent).toBe(limit)
    expect(status.costLimit).toBe(limit)
    expect(status.currency).toBe(DEFAULT_SPEND_PRICING.currency)
    // The gate pauses at the ceiling, not one cent past it.
    expect(status.exceeded).toBe(true)
    expect((await service(tieredLedger({ workspace: limit - 0.01 })).status('ws')).exceeded).toBe(
      false,
    )
  })

  it('serves the same budget verdict through periodUsage as through status', async () => {
    const limit = DEFAULT_SPEND_PRICING.monthlyLimit
    const usage = await service(tieredLedger({ workspace: limit })).periodUsage('ws')
    expect(usage.budget.exceeded).toBe(true)
    expect(usage.budget.costLimit).toBe(limit)
    expect(
      (await service(tieredLedger({ workspace: limit - 0.01 })).periodUsage('ws')).budget.exceeded,
    ).toBe(false)
  })

  it('reports the account tier against its effective limit, and nothing for an inactive one', async () => {
    const accountRepository = {
      get: async () => ({ spendMonthlyLimit: 500 }),
    } as unknown as AccountRepository
    const svc = new SpendService({
      tokenUsageRepository: tieredLedger({ account: 500 }),
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
      accountRepository,
    })
    const status = await svc.accountStatus('acc')
    expect(status?.costLimit).toBe(500)
    expect(status?.exceeded).toBe(true)

    // No configured limit and no operator cap: the tier does not gate, so there is no status
    // to report — null, never a status against an infinite ceiling.
    const inactive = new SpendService({
      tokenUsageRepository: tieredLedger({ account: 500 }),
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
      accountRepository: {
        get: async () => ({ spendMonthlyLimit: null }),
      } as unknown as AccountRepository,
    })
    expect(await inactive.accountStatus('acc')).toBeNull()
  })

  it('clamps a configured tier limit by the operator env cap', async () => {
    const svc = new SpendService({
      tokenUsageRepository: tieredLedger({ account: 90, user: 90 }),
      idGenerator,
      clock: { now: () => NOW },
      pricing: { ...DEFAULT_SPEND_PRICING, accountMonthlyLimitCap: 80, userMonthlyLimitCap: 80 },
      accountRepository: {
        get: async () => ({ spendMonthlyLimit: 500 }),
      } as unknown as AccountRepository,
      userSettingsRepository: {
        get: async () => ({ spendMonthlyLimit: 500 }),
      } as unknown as UserSettingsRepository,
    })
    expect((await svc.accountStatus('acc'))?.costLimit).toBe(80)
    expect((await svc.userStatus('usr'))?.costLimit).toBe(80)
    // Spend of 90 against the clamped 80: the CAP is what the tier gates on, not the 500.
    expect((await svc.accountStatus('acc'))?.exceeded).toBe(true)
    expect((await svc.userStatus('usr'))?.exceeded).toBe(true)
  })

  // The tier above configured a limit, so it stays active whatever the cap does. This is the
  // OTHER activation route, and the only one that tells a configured-limit-only reading of
  // `effectiveTierLimit` apart from the real rule: nothing is configured, so the tier owes its
  // very existence to the operator cap.
  it('activates a tier on the operator cap alone when nothing is configured', async () => {
    const svc = new SpendService({
      tokenUsageRepository: tieredLedger({ account: 90, user: 5 }),
      idGenerator,
      clock: { now: () => NOW },
      pricing: { ...DEFAULT_SPEND_PRICING, accountMonthlyLimitCap: 80, userMonthlyLimitCap: 80 },
      accountRepository: {
        get: async () => ({ spendMonthlyLimit: null }),
      } as unknown as AccountRepository,
      userSettingsRepository: {
        get: async () => ({ spendMonthlyLimit: null }),
      } as unknown as UserSettingsRepository,
    })
    const account = await svc.accountStatus('acc')
    expect(account?.costLimit).toBe(80)
    expect(account?.exceeded).toBe(true)
    // Active does not mean exceeded: the same cap-only tier reports a status well under it.
    const user = await svc.userStatus('usr')
    expect(user?.costLimit).toBe(80)
    expect(user?.exceeded).toBe(false)
  })

  // A tier with NO repository wired at all resolves through the same rule, so an operator cap
  // still gates it: the absent row and a row holding null are the same fact here.
  it('gates an unwired tier on the operator cap', async () => {
    const svc = new SpendService({
      tokenUsageRepository: tieredLedger({ account: 90 }),
      idGenerator,
      clock: { now: () => NOW },
      pricing: { ...DEFAULT_SPEND_PRICING, accountMonthlyLimitCap: 80 },
    })
    expect((await svc.accountStatus('acc'))?.costLimit).toBe(80)
    // ...and with no cap either, it does not gate at all.
    const uncapped = new SpendService({
      tokenUsageRepository: tieredLedger({ account: 90 }),
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
    })
    expect(await uncapped.accountStatus('acc')).toBeNull()
  })

  it('takes a preloaded user limit instead of re-reading the settings row', async () => {
    const userSettingsRepository = {
      get: vi.fn(async () => ({ spendMonthlyLimit: 500 })),
    } as unknown as UserSettingsRepository
    const svc = new SpendService({
      tokenUsageRepository: tieredLedger({ user: 40 }),
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
      userSettingsRepository,
    })
    const status = await svc.userStatus('usr', { configuredLimit: 50 })
    expect(status?.costLimit).toBe(50)
    expect(status?.exceeded).toBe(false)
    expect(userSettingsRepository.get).not.toHaveBeenCalled()
    // A preloaded tier with nothing configured is inactive, exactly as a read one would be.
    expect(await svc.userStatus('usr', { configuredLimit: null })).toBeNull()
  })

  it('reports the operator ceilings for the budget screens', () => {
    expect(service(fakeTokenUsage()).budgetCaps()).toEqual({
      accountMonthlyLimitMax: null,
      userMonthlyLimitMax: null,
      currency: DEFAULT_SPEND_PRICING.currency,
    })
    const capped = service(fakeTokenUsage(), {
      ...DEFAULT_SPEND_PRICING,
      accountMonthlyLimitCap: 400,
      userMonthlyLimitCap: 0,
    })
    // A 0 ceiling is a real ceiling ("no paid spend"), so it must not read back as "uncapped".
    expect(capped.budgetCaps()).toEqual({
      accountMonthlyLimitMax: 400,
      userMonthlyLimitMax: 0,
      currency: DEFAULT_SPEND_PRICING.currency,
    })
  })

  it('reports the breakdown against the workspace currency and this period', async () => {
    const rows = [
      {
        billing: 'metered',
        vendor: null,
        provider: 'anthropic',
        model: 'claude-opus-5',
        inputTokens: 10,
        outputTokens: 5,
        costEstimate: 1.5,
        calls: 2,
      },
    ]
    const svc = new SpendService({
      tokenUsageRepository: {
        ...fakeTokenUsage(),
        usageBreakdownForWorkspace: async () => rows,
      } as unknown as TokenUsageRepository,
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
      workspaceSettingsRepository: {
        get: async () => workspaceSettings({ spendCurrency: 'USD' }),
      } as unknown as WorkspaceSettingsRepository,
    })
    const breakdown = await svc.usageBreakdown('ws')
    expect(breakdown.periodStart).toBe(Date.UTC(2026, 6, 1))
    expect(breakdown.currency).toBe('USD')
    expect(breakdown.rows).toEqual(rows)
  })
})

describe('SpendService.isOverBudget', () => {
  const NOW = Date.UTC(2026, 6, 17)
  const at = (costEstimate: number) => ({ inputTokens: 0, outputTokens: 0, costEstimate })

  function svcFor(
    totals: { workspace?: number; account?: number; user?: number },
    extra: Partial<ConstructorParameters<typeof SpendService>[0]> = {},
  ) {
    return new SpendService({
      tokenUsageRepository: {
        ...fakeTokenUsage(),
        totalsSinceForWorkspace: async () => at(totals.workspace ?? 0),
        totalsSinceForAccount: async () => at(totals.account ?? 0),
        totalsSinceForUser: async () => at(totals.user ?? 0),
      } as unknown as TokenUsageRepository,
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
      ...extra,
    })
  }

  const limit = DEFAULT_SPEND_PRICING.monthlyLimit

  it('pauses at exactly the workspace limit and not a cent below it', async () => {
    expect(await svcFor({ workspace: limit }).isOverBudget('ws')).toBe(true)
    expect(await svcFor({ workspace: limit - 0.01 }).isOverBudget('ws')).toBe(false)
  })

  it('checks the ACCOUNT tier when the caller names one, even with the workspace tier clear', async () => {
    const accountRepository = {
      get: async () => ({ spendMonthlyLimit: 200 }),
    } as unknown as AccountRepository
    expect(
      await svcFor({ account: 200 }, { accountRepository }).isOverBudget('ws', {
        accountId: 'acc',
      }),
    ).toBe(true)
    expect(
      await svcFor({ account: 199 }, { accountRepository }).isOverBudget('ws', {
        accountId: 'acc',
      }),
    ).toBe(false)
    // Named tiers are only consulted when the caller supplies the id.
    expect(await svcFor({ account: 200 }, { accountRepository }).isOverBudget('ws')).toBe(false)
  })

  it('checks the USER tier the same way', async () => {
    const userSettingsRepository = {
      get: async () => ({ spendMonthlyLimit: 20 }),
    } as unknown as UserSettingsRepository
    expect(
      await svcFor({ user: 20 }, { userSettingsRepository }).isOverBudget('ws', { userId: 'usr' }),
    ).toBe(true)
    expect(
      await svcFor({ user: 19.99 }, { userSettingsRepository }).isOverBudget('ws', {
        userId: 'usr',
      }),
    ).toBe(false)
    expect(await svcFor({ user: 20 }, { userSettingsRepository }).isOverBudget('ws')).toBe(false)
  })

  it('never gates on an INACTIVE tier, however much it spent', async () => {
    // No configured limit and no operator cap: `Infinity` is not a ceiling, so the tier's
    // ledger is not even read for a verdict.
    const totalsSinceForAccount = vi.fn(async () => at(1_000_000))
    const svc = new SpendService({
      tokenUsageRepository: {
        ...fakeTokenUsage(),
        totalsSinceForWorkspace: async () => at(0),
        totalsSinceForAccount,
      } as unknown as TokenUsageRepository,
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
      accountRepository: {
        get: async () => ({ spendMonthlyLimit: null }),
      } as unknown as AccountRepository,
    })
    expect(await svc.isOverBudget('ws', { accountId: 'acc' })).toBe(false)
    expect(totalsSinceForAccount).not.toHaveBeenCalled()
  })

  it('reads every tier against ONE period start', async () => {
    const seen: number[] = []
    const record = async (_id: string, since: number) => {
      seen.push(since)
      return at(0)
    }
    const svc = new SpendService({
      tokenUsageRepository: {
        ...fakeTokenUsage(),
        totalsSinceForWorkspace: record,
        totalsSinceForAccount: record,
        totalsSinceForUser: record,
      } as unknown as TokenUsageRepository,
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
      accountRepository: {
        get: async () => ({ spendMonthlyLimit: 100 }),
      } as unknown as AccountRepository,
      userSettingsRepository: {
        get: async () => ({ spendMonthlyLimit: 100 }),
      } as unknown as UserSettingsRepository,
    })
    await svc.isOverBudget('ws', { accountId: 'acc', userId: 'usr' })
    expect(seen).toEqual([Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 1)])
  })
})

describe('SpendService.record — the persisted row', () => {
  function recordingRepo(): { repo: TokenUsageRepository; rows: TokenUsageRecord[] } {
    const rows: TokenUsageRecord[] = []
    return {
      rows,
      repo: {
        ...fakeTokenUsage(),
        record: async (row: TokenUsageRecord) => {
          rows.push(row)
        },
      } as unknown as TokenUsageRepository,
    }
  }

  it('splits `provider:model` and stamps the row with the id generator and clock', async () => {
    const { repo, rows } = recordingRepo()
    const svc = new SpendService({
      tokenUsageRepository: repo,
      idGenerator: { next: (prefix: string) => `${prefix}_1` },
      clock: { now: () => 1_700_000_000_000 },
      pricing: DEFAULT_SPEND_PRICING,
    })
    await svc.record({
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      model: 'anthropic:claude-opus-5',
      usage: { inputTokens: 1, outputTokens: 1 },
      accountId: 'acc',
      userId: 'usr',
      billing: 'subscription',
      vendor: 'claude-code',
    })
    expect(rows[0]).toMatchObject({
      id: 'tok_1',
      workspaceId: 'ws',
      provider: 'anthropic',
      model: 'claude-opus-5',
      accountId: 'acc',
      userId: 'usr',
      billing: 'subscription',
      vendor: 'claude-code',
      createdAt: 1_700_000_000_000,
    })
  })

  it('defaults an unattributed row to a metered workspace-only row rather than dropping the fields', async () => {
    const { repo, rows } = recordingRepo()
    const svc = new SpendService({
      tokenUsageRepository: repo,
      idGenerator,
      clock,
      pricing: DEFAULT_SPEND_PRICING,
    })
    await svc.record({
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      // A bare identifier with no `:` is the whole provider; the model half is empty, which is
      // what makes it resolve to the provider-level (or default) price rather than to nothing.
      model: 'litellm',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    })
    expect(rows[0]).toMatchObject({
      provider: 'litellm',
      model: '',
      accountId: null,
      userId: null,
      billing: 'metered',
      vendor: null,
    })
    expect(rows[0]?.costEstimate).toBeCloseTo(
      DEFAULT_SPEND_PRICING.prices.litellm?.inputPerMillion ?? 0,
      6,
    )
  })

  it('prices a dynamic OpenRouter model at its catalog rate, and asks nothing for other providers', async () => {
    const { repo, rows } = recordingRepo()
    const dynamicPricesFor = vi.fn(async () => [
      { id: 'vendor/model', inputPerMillion: 9, outputPerMillion: 18 },
    ])
    const svc = new SpendService({
      tokenUsageRepository: repo,
      idGenerator,
      clock,
      pricing: DEFAULT_SPEND_PRICING,
      dynamicPricesFor: dynamicPricesFor as unknown as ConstructorParameters<
        typeof SpendService
      >[0]['dynamicPricesFor'],
    })
    await svc.record({
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      model: 'openrouter:vendor/model',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    })
    // The catalog rate, not the bare-`openrouter` fallback the base table would have used.
    expect(rows[0]?.costEstimate).toBeCloseTo(9, 6)

    await svc.record({
      workspaceId: 'ws',
      executionId: 'exec',
      agentKind: 'coder',
      model: 'anthropic:claude-opus-5',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    })
    expect(dynamicPricesFor).toHaveBeenCalledTimes(1)
  })
})

describe('SpendService with no optional repository wired', () => {
  const NOW = Date.UTC(2026, 6, 17, 9, 30)
  const svc = (over: Record<string, unknown> = {}) =>
    new SpendService({
      tokenUsageRepository: fakeTokenUsage(),
      idGenerator,
      clock: { now: () => NOW },
      pricing: { ...DEFAULT_SPEND_PRICING, accountMonthlyLimitCap: 80, userMonthlyLimitCap: 40 },
      ...over,
    })

  it('resolves each tier from the operator cap alone rather than reaching for a repository', async () => {
    // A deployment can wire the ledger without the account/user stores; the tiers must still
    // resolve, from the cap alone, instead of dereferencing a repository that is not there.
    expect((await svc().accountStatus('acc'))?.costLimit).toBe(80)
    expect((await svc().userStatus('usr'))?.costLimit).toBe(40)
    expect(await svc().isOverBudget('ws', { accountId: 'acc', userId: 'usr' })).toBe(false)
  })

  it('serves the base pricing for every workspace a batch forecast asks about', async () => {
    // `forecastWorkspaces` resolves pricing for MANY ids at once; with no settings store every
    // one of them must come back on the base table, not be dropped from the result.
    const spend = new Map([
      ['ws1', { costEstimate: 90, firstSeenAt: NOW - 5 * 24 * 60 * 60 * 1000 }],
      ['ws2', { costEstimate: 10, firstSeenAt: NOW - 5 * 24 * 60 * 60 * 1000 }],
    ])
    const service = svc({
      tokenUsageRepository: {
        ...fakeTokenUsage(),
        meteredSpendByWorkspaceSince: async () => spend,
      } as unknown as TokenUsageRepository,
    })
    const forecasts = await service.forecastWorkspaces(['ws1', 'ws2'], NOW)
    expect([...forecasts.keys()].sort()).toEqual(['ws1', 'ws2'])
    for (const f of forecasts.values()) {
      expect(f.costLimit).toBe(DEFAULT_SPEND_PRICING.monthlyLimit)
      expect(f.currency).toBe(DEFAULT_SPEND_PRICING.currency)
    }
  })

  it('is a no-op to invalidate a limit when no cache is wired', async () => {
    await expect(svc().invalidateAccountLimit('acc')).resolves.toBeUndefined()
    await expect(svc().invalidateUserLimit('usr')).resolves.toBeUndefined()
  })

  it('falls back to the cap when the repository has no row for the id', async () => {
    // A brand-new account/user has no settings row at all; that is "nothing configured", not a
    // crash, and the cap alone must still activate the tier.
    const service = svc({
      accountRepository: { get: async () => undefined } as unknown as AccountRepository,
      userSettingsRepository: { get: async () => null } as unknown as UserSettingsRepository,
    })
    expect((await service.accountStatus('acc'))?.costLimit).toBe(80)
    expect((await service.userStatus('usr'))?.costLimit).toBe(40)
  })
})

describe('SpendService tier statuses: the remaining verdict edges', () => {
  const NOW = Date.UTC(2026, 6, 17, 9, 30)
  const at = (costEstimate: number) => ({ inputTokens: 1, outputTokens: 1, costEstimate })

  const svc = (accountSpend: number, userSpend: number) =>
    new SpendService({
      tokenUsageRepository: {
        ...fakeTokenUsage(),
        totalsSinceForAccount: async () => at(accountSpend),
        totalsSinceForUser: async () => at(userSpend),
      } as unknown as TokenUsageRepository,
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
      accountRepository: {
        get: async () => ({ spendMonthlyLimit: 500 }),
      } as unknown as AccountRepository,
      userSettingsRepository: {
        get: async () => ({ spendMonthlyLimit: 200 }),
      } as unknown as UserSettingsRepository,
    })

  it('counts spend AT the limit as exceeded on the account AND the user tier', async () => {
    expect((await svc(500, 200).accountStatus('acc'))?.exceeded).toBe(true)
    expect((await svc(500, 200).userStatus('usr'))?.exceeded).toBe(true)
    // One cent under is not exceeded: the boundary is inclusive, not approximate.
    expect((await svc(499.99, 199.99).accountStatus('acc'))?.exceeded).toBe(false)
    expect((await svc(499.99, 199.99).userStatus('usr'))?.exceeded).toBe(false)
  })

  it('reports an active tier that is nowhere near its limit as not exceeded', async () => {
    const account = await svc(1, 1).accountStatus('acc')
    expect(account).toMatchObject({ costLimit: 500, costSpent: 1, exceeded: false })
    expect((await svc(1, 1).userStatus('usr'))?.exceeded).toBe(false)
  })

  it('prices a preloaded user limit without reading the settings row again', async () => {
    const get = vi.fn(async () => ({ spendMonthlyLimit: 200 }))
    const service = new SpendService({
      tokenUsageRepository: {
        ...fakeTokenUsage(),
        totalsSinceForUser: async () => at(200),
      } as unknown as TokenUsageRepository,
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
      userSettingsRepository: { get } as unknown as UserSettingsRepository,
    })
    const status = await service.userStatus('usr', { configuredLimit: 200 })
    expect(status).toMatchObject({ costLimit: 200, exceeded: true })
    expect(get).not.toHaveBeenCalled()
  })
})

describe('SpendService.isOverBudget: what it declines to ask', () => {
  const NOW = Date.UTC(2026, 6, 17, 9, 30)

  it('does not read an INACTIVE tier’s ledger at all', async () => {
    // No configured limit and no operator cap means there is no ceiling to compare against, so
    // the period query for that tier is a round trip bought for an answer that cannot change.
    const totalsSinceForAccount = vi.fn(async () => ({
      inputTokens: 0,
      outputTokens: 0,
      costEstimate: 10_000,
    }))
    const totalsSinceForUser = vi.fn(async () => ({
      inputTokens: 0,
      outputTokens: 0,
      costEstimate: 10_000,
    }))
    const service = new SpendService({
      tokenUsageRepository: {
        ...fakeTokenUsage(),
        totalsSinceForAccount,
        totalsSinceForUser,
      } as unknown as TokenUsageRepository,
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
      accountRepository: {
        get: async () => ({ spendMonthlyLimit: null }),
      } as unknown as AccountRepository,
      userSettingsRepository: {
        get: async () => ({ spendMonthlyLimit: null }),
      } as unknown as UserSettingsRepository,
    })
    expect(await service.isOverBudget('ws', { accountId: 'acc', userId: 'usr' })).toBe(false)
    expect(totalsSinceForAccount).not.toHaveBeenCalled()
    expect(totalsSinceForUser).not.toHaveBeenCalled()
  })
})

describe('SpendService forecast windows', () => {
  const NOW = Date.UTC(2026, 6, 17, 9, 30)

  it('reads the burn-rate window BACKWARDS from now, for workspaces and accounts alike', async () => {
    // The window is trailing: a forward one selects rows that do not exist yet, so every burn
    // rate would be zero and no overrun would ever be projected.
    const workspaceSince: number[] = []
    const accountSince: number[] = []
    const service = new SpendService({
      tokenUsageRepository: {
        ...fakeTokenUsage(),
        meteredSpendByWorkspaceSince: async (_ids: string[], since: number) => {
          workspaceSince.push(since)
          return new Map()
        },
        meteredSpendByAccountSince: async (_ids: string[], since: number) => {
          accountSince.push(since)
          return new Map()
        },
      } as unknown as TokenUsageRepository,
      idGenerator,
      clock: { now: () => NOW },
      pricing: DEFAULT_SPEND_PRICING,
    })
    await service.forecastWorkspaces(['ws'], NOW)
    await service.forecastAccounts(['acc'], NOW)
    for (const since of [...workspaceSince, ...accountSince]) {
      expect(since).toBeLessThanOrEqual(NOW)
    }
    // The period read and the window read are DIFFERENT points, or the window measures the
    // whole period and the rate is the period average rather than the recent one.
    expect(new Set(workspaceSince).size).toBe(2)
    expect(new Set(accountSince).size).toBe(2)
  })
})
