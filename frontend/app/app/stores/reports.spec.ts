import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAccountsStore } from '~/stores/accounts'
import { useReportsStore } from '~/stores/reports'
import type { ReportsView } from '~/types/execution'

// The reports view is loaded three ways that can each be triggered while another is still in
// flight — the window buttons, the board filter and the refresh button — so the store's
// monotonicity guard is the thing that keeps the panel from showing numbers for a window the
// user already left. These drive that race directly.

/** Minimal projection — only what the store stores and these assertions read. */
function view(over: Partial<ReportsView> = {}): ReportsView {
  return {
    window: '7d',
    generatedAt: 1_000,
    since: 0,
    workspaceId: null,
    currency: 'EUR',
    totals: { inputTokens: 0, outputTokens: 0, calls: 0, meteredCost: 0, subscriptionCost: 0 },
    spend: { byModel: [], byAgentKind: [], byWorkspace: [], byService: [], byTaskType: [] },
    activity: { byWorkspace: [], byService: [], byTaskType: [] },
    trend: { bucketMs: 1_000, points: [] },
    ...over,
  } as ReportsView
}

/** Seed an active account, since every load is scoped to one. */
function seedAccount() {
  const accounts = useAccountsStore()
  accounts.accounts = [
    {
      id: 'acc1',
      type: 'org',
      name: 'Acme',
      githubAccountLogin: null,
      createdAt: 0,
      roles: null,
    },
  ] as never
  accounts.activeAccountId = 'acc1'
}

describe('reports store — concurrent loads', () => {
  beforeEach(() => {
    seedAccount()
  })

  it('a stale load never overwrites a fresher one that already resolved', async () => {
    // The user picks 24h, then immediately 90d. The 24h request is slower and lands LAST;
    // committing it would leave the panel labelled 90d while showing 24h numbers.
    let resolveSlow!: (v: ReportsView) => void
    const slow = new Promise<ReportsView>((res) => {
      resolveSlow = res
    })
    const responses: Record<string, Promise<ReportsView>> = {
      '24h': slow,
      '90d': Promise.resolve(view({ window: '90d', totals: { ...view().totals, calls: 42 } })),
    }
    vi.stubGlobal('useApi', () => ({
      getReports: (_id: string, window: string) => responses[window]!,
    }))
    const store = useReportsStore()

    const first = store.setWindow('24h')
    const second = store.setWindow('90d')
    await second
    resolveSlow(view({ window: '24h', totals: { ...view().totals, calls: 7 } }))
    await first

    expect(store.view?.window).toBe('90d')
    expect(store.view?.totals.calls).toBe(42)
    // The superseded load must not resurrect the spinner it started either.
    expect(store.loading).toBe(false)
  })

  it('a superseded FAILURE never replaces the newer view with an error', async () => {
    // The same race the other way round: an in-flight load rejects after a later
    // one succeeded. Committing it would blank a perfectly good panel.
    let rejectSlow!: (e: Error) => void
    const slow = new Promise<ReportsView>((_res, rej) => {
      rejectSlow = rej
    })
    const responses: Record<string, Promise<ReportsView>> = {
      '24h': slow,
      '90d': Promise.resolve(view({ window: '90d' })),
    }
    vi.stubGlobal('useApi', () => ({
      getReports: (_id: string, window: string) => responses[window]!,
    }))
    const store = useReportsStore()

    const first = store.setWindow('24h')
    await store.setWindow('90d')
    rejectSlow(new Error('gateway timeout'))
    await first

    expect(store.failed).toBe(false)
    expect(store.error).toBeNull()
    expect(store.view?.window).toBe('90d')
  })

  it('records a failure from the newest load, with the raw message as detail', async () => {
    vi.stubGlobal('useApi', () => ({
      getReports: () => Promise.reject(new Error('reports are not available')),
    }))
    const store = useReportsStore()
    await store.load()
    expect(store.failed).toBe(true)
    // Raw backend prose only — the localized heading is the panel's job.
    expect(store.error).toBe('reports are not available')
    expect(store.loading).toBe(false)
  })
})
