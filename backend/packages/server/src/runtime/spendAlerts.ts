import type { BudgetAlert, NotificationPayload } from '@cat-factory/contracts'
import { distinctAccountIds, spendThresholdCardContent } from '@cat-factory/orchestration'
import type { Logger, Notification, Workspace } from '@cat-factory/kernel'
import { describeError } from '@cat-factory/kernel'
import type { ScopedSpendForecast } from '@cat-factory/spend'
import { spendAlertEscalated, spendAlertFiring } from '@cat-factory/spend'
import type { ServerContainer } from '../http/env.js'

// Runtime-neutral spend-alert sweep: the PROACTIVE half of the spend safeguard, shared by both
// facades' periodic sweeps (the Worker's cron `scheduled` handler and the Node `setInterval`
// sweeper) exactly like `sweepPlatformHealth`.
//
// The safeguard itself only ever speaks once the money is gone: `isOverBudget` pauses a run at
// the ceiling and a `budget_paused` card appears. That is the worst possible moment to learn a
// budget was running out, so this sweep evaluates each workspace's (and its account's) forward
// position (burn rate, month-end projection) and raises a `budget_threshold` card while there
// is still time to raise the limit or stop a runaway.
//
// Nothing here can gate anything. The forecast is advisory by construction (see
// `@cat-factory/spend`'s `forecast.logic.ts`), so a projection bug costs a wrong card and never
// a paused or unpaused run.
//
// TWO reads serve the whole deployment: the ledger aggregates are batched per scope set, and the
// per-workspace notified state is one chunked `listLatestByType`. A point read per workspace
// would be the banned N+1, run every few minutes across every tenant.

/**
 * How often a pass runs on both facades. Spend is a slow signal: the burn rate is measured over
 * a week and a budget is monthly, so a tighter cadence would buy nothing and cost four aggregate
 * queries per tenant set. Shared rather than per-facade so the Worker's stateless cron window and
 * the Node timer cannot drift into meaning different things.
 */
export const SPEND_ALERT_INTERVAL_MS = 15 * 60_000

/**
 * One pass. Returns how many workspaces a card was raised on.
 *
 * A no-op when the notifications module is not wired (tests, mothership local nodes). Unlike the
 * platform-health sweep there is no opt-in flag: a budget is something a deployment configured on
 * purpose, and a safeguard that warns only when an operator remembered to switch the warning on
 * is the silent pause this exists to replace.
 *
 * Best-effort per workspace: one workspace's failed raise is logged and skipped, never aborting
 * the rest. This sweep must not become the silent background failure it exists to prevent.
 */
export async function sweepSpendAlerts(
  container: ServerContainer,
  now: number,
  logger?: Logger,
): Promise<{ raised: number }> {
  const notifications = container.notifications
  if (!notifications) return { raised: 0 }

  const workspaces = await container.workspaceService.list(null)
  if (workspaces.length === 0) return { raised: 0 }
  const workspaceIds = workspaces.map((ws) => ws.id)

  const spend = container.spendService
  // The account tier is evaluated ONCE per account and fanned out to its workspaces, matching
  // the scope its rollup is computed at. Legacy null-account boards contribute nothing here and
  // are still forecast on their own workspace tier.
  const [byWorkspace, byAccount, lastNotified] = await Promise.all([
    spend.forecastWorkspaces(workspaceIds, now),
    spend.forecastAccounts(distinctAccountIds(workspaces), now),
    notifications.service.listLatestByType(workspaceIds, 'budget_threshold'),
  ])

  let raised = 0
  for (const workspace of workspaces) {
    try {
      if (
        await settleWorkspace(
          { container, logger },
          { workspace, byWorkspace, byAccount, lastNotified },
        )
      ) {
        raised += 1
      }
    } catch (error) {
      logger?.warn('spend-alerts: failed to evaluate workspace', {
        scope: 'spend-alerts',
        workspaceId: workspace.id,
        ...describeError(error),
      })
    }
  }
  return { raised }
}

/** The collaborators one workspace's pass needs, bound once. */
interface SettleDeps {
  container: ServerContainer
  logger?: Logger
}

/** This pass's forecasts plus the state each workspace was last notified at. */
interface SettleInput {
  workspace: Workspace
  byWorkspace: Map<string, ScopedSpendForecast>
  byAccount: Map<string, ScopedSpendForecast>
  lastNotified: Map<string, Notification>
}

/**
 * Evaluate ONE workspace and raise its card when the alert state has ESCALATED. Returns whether
 * a card was raised.
 *
 * There is deliberately no clearing counterpart. A crossed threshold does not un-cross in any
 * way worth telling anyone about (spend only rises within a period), and the card auto-expires
 * with the period: the next period's first crossing raises a new one because the payload's
 * `budgetPeriodStart` differs. Auto-dismissing on a fall-back would only be possible for the
 * projection, and would make the card flicker as the burn rate wobbles around the limit.
 */
async function settleWorkspace(deps: SettleDeps, input: SettleInput): Promise<boolean> {
  const { workspace, byWorkspace, byAccount, lastNotified } = input
  // Built workspace-tier-first, because the alert list is part of the card's dedup identity: an
  // order that depended on which tier happened to be evaluated first would re-deliver the card on
  // a refactor that changed nothing a human can see.
  const firing: FiringTier[] = [
    { tier: 'workspace' as const, forecast: byWorkspace.get(workspace.id) },
    {
      tier: 'account' as const,
      forecast: workspace.accountId ? byAccount.get(workspace.accountId) : undefined,
    },
  ].filter(isFiring)
  if (firing.length === 0) return false

  // The WORST firing tier owns the headline and the escalation decision. A workspace holds at
  // most one block-less card per type, so the two tiers cannot each have one; leading with the
  // worse of them is what keeps the card honest when both fire.
  const worst = [...firing].sort(bySeverity)[0]!
  const previous = readNotifiedState(lastNotified.get(workspace.id))
  if (!spendAlertEscalated(previous, worst.forecast.alert)) return false

  const alerts: BudgetAlert[] = firing.map(({ tier, forecast }) => ({
    tier,
    threshold: forecast.alert.threshold,
    projectedOverrun: forecast.alert.projectedOverrun,
  }))
  const { title, body } = spendThresholdCardContent(alerts, {
    tier: worst.tier,
    costLimit: worst.forecast.costLimit,
    currency: worst.forecast.currency,
    threshold: worst.forecast.alert.threshold,
  })
  await deps.container.notifications?.service.raise(workspace.id, {
    type: 'budget_threshold',
    blockId: null,
    executionId: null,
    title,
    body,
    payload: {
      budgetPeriodStart: worst.forecast.alert.periodStart,
      budgetAlerts: alerts,
    },
  })
  deps.logger?.info('spend-alerts: raised a budget threshold card', {
    scope: 'spend-alerts',
    workspaceId: workspace.id,
    // The tiers and their STATE, never the amounts: a log line naming a workspace's spend puts a
    // per-tenant financial figure into the deployment's operational log.
    tiers: alerts.map((a) => a.tier).join(','),
    threshold: worst.forecast.alert.threshold,
    projectedOverrun: worst.forecast.alert.projectedOverrun,
  })
  return true
}

/** One tier that is firing for a workspace, with the forecast behind it. */
interface FiringTier {
  tier: BudgetAlert['tier']
  forecast: ScopedSpendForecast
}

/** Narrowing predicate: a tier whose forecast is present AND firing. */
function isFiring(entry: {
  tier: BudgetAlert['tier']
  forecast: ScopedSpendForecast | undefined
}): entry is FiringTier {
  return entry.forecast != null && spendAlertFiring(entry.forecast.alert)
}

/**
 * Worst-first: a crossed threshold outranks a bare projection, and a higher crossed threshold
 * outranks a lower one. Total, so the sort is deterministic when both tiers are in the same state.
 */
function bySeverity(a: FiringTier, b: FiringTier): number {
  return (b.forecast.alert.threshold ?? 0) - (a.forecast.alert.threshold ?? 0)
}

/**
 * The state a workspace was last notified at, read back off its most recent card.
 *
 * The card row IS the sweep's alert store: it is persisted, shared by every replica, and
 * survives a restart, which an in-process "already notified" flag would not on a multi-node
 * deployment. A card with no period stamped (nothing was ever raised, or a card written before
 * this payload existed) reads as "never notified", so the next firing state escalates, which is the safe
 * direction, since the cost is one extra card rather than a missed warning.
 */
function readNotifiedState(card: Notification | undefined): {
  periodStart: number
  threshold: number | null
  projectedOverrun: boolean
} | null {
  const payload: NotificationPayload | null | undefined = card?.payload
  const periodStart = payload?.budgetPeriodStart
  if (typeof periodStart !== 'number') return null
  const alerts = payload?.budgetAlerts ?? []
  return {
    periodStart,
    // Folded back to the same worst-tier shape the escalation test compares against, so a card
    // raised for the account tier cannot be re-raised a minute later for a milder workspace one.
    threshold: alerts.reduce<number | null>(
      (max, a) => (a.threshold != null && (max == null || a.threshold > max) ? a.threshold : max),
      null,
    ),
    projectedOverrun: alerts.some((a) => a.projectedOverrun),
  }
}
