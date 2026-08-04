import type { Notification, Workspace } from '@cat-factory/kernel'
import type { ScopedSpendForecast } from '@cat-factory/spend'
import { describe, expect, it } from 'vitest'
import type { ServerContainer } from '../src/http/env.js'
import { sweepSpendAlerts } from '../src/runtime/spendAlerts.js'

// Drives the runtime-neutral spend-alert sweep over a minimal fake container: only the fields it
// reads (workspaceService.list, spendService.forecastWorkspaces/forecastAccounts,
// notifications.service.listLatestByType/raise) are present, cast to ServerContainer. The
// forecast MATH is unit-tested in `@cat-factory/spend`; what is asserted here is the sweep's own
// job: who gets a card, and above all when a card is NOT raised again.

const PERIOD_START = Date.UTC(2026, 6, 1)
const NOW = PERIOD_START + 10 * 24 * 60 * 60 * 1000

function workspace(id: string, accountId: string | null): Workspace {
  return { id, name: id, description: null, createdAt: 0, accountId }
}

/** A firing forecast: `threshold` crossed and/or a projected overrun. */
function forecast(overrides: {
  threshold?: number | null
  projectedOverrun?: boolean
  costLimit?: number
  currency?: string
}): ScopedSpendForecast {
  const costLimit = overrides.costLimit ?? 100
  return {
    costSpent: costLimit * 0.85,
    costLimit,
    currency: overrides.currency ?? 'EUR',
    forecast: {
      burnRatePerDay: 4,
      projectedTotal: costLimit * 1.2,
      projectedExhaustionAt: null,
      consumedFraction: 0.85,
      confidence: 'ok',
    },
    alert: {
      periodStart: PERIOD_START,
      threshold: overrides.threshold === undefined ? 0.8 : overrides.threshold,
      projectedOverrun: overrides.projectedOverrun ?? false,
    },
  }
}

interface RaiseCall {
  workspaceId: string
  title: string
  body: string
  payload?: Record<string, unknown>
}

function makeContainer(opts: {
  workspaces: Workspace[]
  byWorkspace?: Record<string, ScopedSpendForecast>
  byAccount?: Record<string, ScopedSpendForecast>
  /** The newest card per workspace, whatever its status (the notified-state read). */
  lastNotified?: Record<string, Notification>
  hasNotifications?: boolean
}): { container: ServerContainer; raises: RaiseCall[] } {
  const raises: RaiseCall[] = []
  const notifications = {
    service: {
      async listLatestByType(workspaceIds: string[]) {
        const out = new Map<string, Notification>()
        for (const id of workspaceIds) {
          const card = opts.lastNotified?.[id]
          if (card) out.set(id, card)
        }
        return out
      },
      async raise(workspaceId: string, input: RaiseCall & { payload?: Record<string, unknown> }) {
        raises.push({
          workspaceId,
          title: input.title,
          body: input.body,
          payload: input.payload,
        })
        return { id: 'ntf_1' } as unknown as Notification
      },
    },
  }
  const container = {
    workspaceService: { list: async () => opts.workspaces },
    spendService: {
      forecastWorkspaces: async () => new Map(Object.entries(opts.byWorkspace ?? {})),
      forecastAccounts: async () => new Map(Object.entries(opts.byAccount ?? {})),
    },
    notifications: opts.hasNotifications === false ? undefined : notifications,
  } as unknown as ServerContainer
  return { container, raises }
}

/** A card carrying an already-notified alert state, as the sweep reads it back. */
function card(payload: Record<string, unknown>): Notification {
  return {
    id: 'ntf_prev',
    type: 'budget_threshold',
    status: 'open',
    severity: 'normal',
    blockId: null,
    executionId: null,
    title: 't',
    body: 'b',
    payload: payload as Notification['payload'],
    createdAt: 1,
    resolvedAt: null,
  }
}

describe('sweepSpendAlerts', () => {
  it('raises a workspace-scoped card for a crossed threshold', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1')],
      byWorkspace: { ws_1: forecast({ threshold: 0.8 }) },
    })
    expect(await sweepSpendAlerts(container, NOW)).toEqual({ raised: 1 })
    expect(raises).toHaveLength(1)
    expect(raises[0]!.title).toContain('80%')
    expect(raises[0]!.payload).toEqual({
      budgetPeriodStart: PERIOD_START,
      budgetAlerts: [{ tier: 'workspace', threshold: 0.8, projectedOverrun: false }],
    })
  })

  it('raises nothing for a workspace that is not firing', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1')],
      byWorkspace: { ws_1: forecast({ threshold: null, projectedOverrun: false }) },
    })
    expect(await sweepSpendAlerts(container, NOW)).toEqual({ raised: 0 })
    expect(raises).toEqual([])
  })

  it('does not re-raise the same crossing on a later pass', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1')],
      byWorkspace: { ws_1: forecast({ threshold: 0.8 }) },
      lastNotified: {
        ws_1: card({
          budgetPeriodStart: PERIOD_START,
          budgetAlerts: [{ tier: 'workspace', threshold: 0.8, projectedOverrun: false }],
        }),
      },
    })
    expect(await sweepSpendAlerts(container, NOW)).toEqual({ raised: 0 })
    expect(raises).toEqual([])
  })

  it('stays silent when the human DISMISSED the card and nothing has escalated', async () => {
    // The whole reason the notified-state read ignores status: a crossed threshold stays crossed
    // for the rest of the month, so reading only OPEN cards would re-raise this every pass.
    const dismissed: Notification = {
      ...card({
        budgetPeriodStart: PERIOD_START,
        budgetAlerts: [{ tier: 'workspace', threshold: 0.8, projectedOverrun: false }],
      }),
      status: 'dismissed',
      resolvedAt: 2,
    }
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1')],
      byWorkspace: { ws_1: forecast({ threshold: 0.8 }) },
      lastNotified: { ws_1: dismissed },
    })
    expect(await sweepSpendAlerts(container, NOW)).toEqual({ raised: 0 })
    expect(raises).toEqual([])
  })

  it('re-raises when a higher threshold is crossed, and at the period rollover', async () => {
    const previous = card({
      budgetPeriodStart: PERIOD_START,
      budgetAlerts: [{ tier: 'workspace', threshold: 0.8, projectedOverrun: false }],
    })
    const escalated = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1')],
      byWorkspace: { ws_1: forecast({ threshold: 0.95 }) },
      lastNotified: { ws_1: previous },
    })
    expect(await sweepSpendAlerts(escalated.container, NOW)).toEqual({ raised: 1 })

    const rolled = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1')],
      byWorkspace: { ws_1: forecast({ threshold: 0.8 }) },
      lastNotified: {
        ws_1: card({
          budgetPeriodStart: PERIOD_START - 1,
          budgetAlerts: [{ tier: 'workspace', threshold: 0.8, projectedOverrun: false }],
        }),
      },
    })
    expect(await sweepSpendAlerts(rolled.container, NOW)).toEqual({ raised: 1 })
  })

  it('fans an ACCOUNT-tier alert onto every workspace of that account', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1'), workspace('ws_2', 'acc_1'), workspace('ws_3', null)],
      byAccount: { acc_1: forecast({ threshold: 0.8 }) },
    })
    expect(await sweepSpendAlerts(container, NOW)).toEqual({ raised: 2 })
    expect(raises.map((r) => r.workspaceId)).toEqual(['ws_1', 'ws_2'])
    expect(raises[0]!.payload?.budgetAlerts).toEqual([
      { tier: 'account', threshold: 0.8, projectedOverrun: false },
    ])
  })

  it('leads with the WORSE tier when both fire, and lists them both', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1')],
      byWorkspace: { ws_1: forecast({ threshold: null, projectedOverrun: true }) },
      byAccount: { acc_1: forecast({ threshold: 0.95, costLimit: 500, currency: 'USD' }) },
    })
    expect(await sweepSpendAlerts(container, NOW)).toEqual({ raised: 1 })
    // The account tier crossed a real threshold; the workspace tier only projects one. The
    // headline names the account and its OWN limit + currency, never the workspace's.
    expect(raises[0]!.title).toContain('account budget')
    expect(raises[0]!.body).toContain('500 USD')
    expect(raises[0]!.payload?.budgetAlerts).toEqual([
      { tier: 'workspace', threshold: null, projectedOverrun: true },
      { tier: 'account', threshold: 0.95, projectedOverrun: false },
    ])
  })

  it('re-raises when a SECOND tier starts firing beside an unchanged first one', async () => {
    // The workspace has been at 80% since the last pass, so the WORST tier has not moved; what
    // is new is the account's projected overrun. Escalation is decided on the fold of every
    // firing tier, so this is news; deciding it on the worst tier alone would drop the account's
    // warning silently and permanently (nothing else about this period will ever change it).
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1')],
      byWorkspace: { ws_1: forecast({ threshold: 0.8 }) },
      byAccount: { acc_1: forecast({ threshold: null, projectedOverrun: true }) },
      lastNotified: {
        ws_1: card({
          budgetPeriodStart: PERIOD_START,
          budgetAlerts: [{ tier: 'workspace', threshold: 0.8, projectedOverrun: false }],
        }),
      },
    })
    expect(await sweepSpendAlerts(container, NOW)).toEqual({ raised: 1 })
    expect(raises[0]!.payload?.budgetAlerts).toEqual([
      { tier: 'workspace', threshold: 0.8, projectedOverrun: false },
      { tier: 'account', threshold: null, projectedOverrun: true },
    ])
  })

  it('does not re-raise once BOTH tiers have been notified', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1')],
      byWorkspace: { ws_1: forecast({ threshold: 0.8 }) },
      byAccount: { acc_1: forecast({ threshold: null, projectedOverrun: true }) },
      lastNotified: {
        ws_1: card({
          budgetPeriodStart: PERIOD_START,
          budgetAlerts: [
            { tier: 'workspace', threshold: 0.8, projectedOverrun: false },
            { tier: 'account', threshold: null, projectedOverrun: true },
          ],
        }),
      },
    })
    expect(await sweepSpendAlerts(container, NOW)).toEqual({ raised: 0 })
    expect(raises).toEqual([])
  })

  it('is a no-op when the notifications module is not wired', async () => {
    const { container, raises } = makeContainer({
      workspaces: [workspace('ws_1', 'acc_1')],
      byWorkspace: { ws_1: forecast({ threshold: 0.8 }) },
      hasNotifications: false,
    })
    expect(await sweepSpendAlerts(container, NOW)).toEqual({ raised: 0 })
    expect(raises).toEqual([])
  })
})
