import {
  alertsHaveRunEvidence,
  distinctAccountIds,
  evaluatePlatformHealth,
  platformAlertReasons,
  platformHealthCardContent,
  resolveAccountAlertConfig,
} from '@cat-factory/orchestration'
import type {
  PlatformAlert,
  PlatformAlertReason,
  PlatformAlertSettings,
  PlatformAlertWindow,
  PlatformFailingRun,
} from '@cat-factory/contracts'
import type { ServerContainer } from '../http/env.js'
import type {
  Logger,
  Notification,
  PlatformAlertEvent,
  PlatformAlertSink,
  PlatformFailedRunRef,
} from '@cat-factory/kernel'
import { describeError, noopLogger, runBestEffort } from '@cat-factory/kernel'
import { sweepHealth } from '../observability/sweepHealth.js'

// Runtime-neutral platform-health ALERT sweep — the push counterpart to the operator dashboard
// read, shared by both facades' periodic sweeps (the Worker's cron `scheduled` handler and the
// Node `setInterval` sweeper), exactly like `escalateStaleNotifications`. It evaluates each
// account's aggregate run-health projection (the SAME `PlatformObservabilityService.summarize`
// the dashboard reads, no new SQL) against that account's thresholds and, per account:
//   - raises ONE `platform_health` notification per workspace when a ceiling is crossed, or
//   - clears the open card when the account has recovered.
// The card's identity is the FIRING REASON SET, and the sweep raises only when that set CHANGES
// (the "state-change dedup, not every sweep" requirement), so a persistently-unhealthy
// deployment neither re-toasts the inbox nor rewrites the row on every pass.
//
// Each of those two state changes is also pushed to the workspace's registered outbound endpoint
// through the `PlatformAlertSink` port, which is what an ON-CALL system subscribes to. It is a
// separate family rather than the `platform_health` card travelling down the notification webhook
// (which it can, and for a human overseer should) because a card is re-delivered whenever a human
// acts on it or dismisses it, and on the wire that is indistinguishable from the sweep dismissing
// the card because the deployment recovered — so a pager would close its incident whenever
// somebody tidied their inbox. The edges below are the sweep's own verdict, which is the only
// thing that can honestly say "resolved".
//
// A no-op unless alerting is opted in AND both the notifications module and the platform-
// observability read are wired (tests / no telemetry DB / mothership local nodes). Best-effort
// per account: a failed summarize/raise for one account is logged and skipped, never aborting
// the others — this sweep must not become the silent background failure it exists to catch.

/**
 * How many failing runs a card links to per workspace. Small on purpose: the card is a pointer
 * at the evidence, not a report, and the dashboard behind it is the complete, live view. The
 * count of what was left out rides the payload beside the sample.
 */
const FAILING_RUN_SAMPLE = 5

/** Whether an open card's stored reason set already matches the one now firing. */
function sameReasonSet(card: Notification | undefined, reasons: PlatformAlertReason[]): boolean {
  const stored = card?.payload?.platformAlerts
  return (
    Array.isArray(stored) &&
    stored.length === reasons.length &&
    stored.every((r, i) => r === reasons[i])
  )
}

/** The workspace's slice of the account's failing-run sample, in payload shape. */
function failingRunsFor(refs: PlatformFailedRunRef[], workspaceId: string): PlatformFailingRun[] {
  return refs
    .filter((r) => r.workspaceId === workspaceId)
    .map((r) => ({
      executionId: r.executionId,
      blockId: r.blockId,
      failureKind: r.failureKind,
      createdAt: r.createdAt,
    }))
}

/**
 * Run one platform-health alert pass across every account. Returns the number of workspaces a
 * card was raised on and the number cleared. Enumerates accounts from the workspace projection
 * (`workspaceService.list(null)` → distinct non-null account ids), the same tenant-enumeration
 * shape the platform-metrics + artifact-retention sweeps use — NOT a per-row point-read.
 *
 * Time comes from the services' injected clock (`summarize`, `raise` and `clearByType` all
 * stamp `now` themselves), so this helper takes no `now` — unlike `escalateStaleNotifications`,
 * whose cutoff is caller-supplied.
 */
export async function sweepPlatformHealth(
  container: ServerContainer,
  logger?: Logger,
): Promise<{ raised: number; cleared: number }> {
  const cfg = container.config.platformAlerts
  const notifications = container.notifications
  const observability = container.platformObservability
  if (!cfg.enabled || !notifications || !observability) return { raised: 0, cleared: 0 }

  const workspaces = await container.workspaceService.list(null)
  // Group workspaces by account so each account is summarized ONCE (a handful of GROUP BY
  // queries), then the verdict is fanned to every workspace in the account. Legacy null-account
  // boards are skipped: the platform-metrics read is account-scoped (matches `distinctAccountIds`).
  const byAccount = new Map<string, string[]>()
  for (const ws of workspaces) {
    if (!ws.accountId) continue
    const list = byAccount.get(ws.accountId)
    if (list) list.push(ws.id)
    else byAccount.set(ws.accountId, [ws.id])
  }

  // Which workspaces already hold an open `platform_health` card, learned in ONE batched read
  // up front rather than a `findOpenByType` point-read per workspace inside the loop (that N+1
  // would run across the whole deployment every sweep, every couple of minutes). The CARDS,
  // not just their ids: the stored reason set on each is what makes the raise below
  // state-change-driven rather than every-pass.
  const openCards = await notifications.service.listOpenByType(
    workspaces.map((ws) => ws.id),
    'platform_health',
  )

  const worstSweep = sweepHealth.worst()
  let raised = 0
  let cleared = 0
  for (const accountId of distinctAccountIds(workspaces)) {
    const workspaceIds = byAccount.get(accountId) ?? []
    try {
      // The account's own thresholds: the deployment env defaults with this account's stored
      // settings layered over them (slice 6's settings surface writes those). Read per account
      // rather than per workspace, matching the scope the projection is computed at, and
      // necessarily BEFORE the change check below, since the thresholds are what decide which
      // reasons fire. It is not the per-pass cost that reads like: `AccountSettingsService.resolve`
      // goes through the app cache seam (invalidated on every settings write), so the steady state
      // is a cache hit per account, not a row read and a decrypt.
      const account = resolveAccountAlertConfig(
        cfg,
        await readAccountAlertSettings(container, accountId, logger),
      )
      if (!account.enabled) continue
      const snapshot = await observability.summarize(accountId, account.window)
      // The sweeper streak is deployment-wide, not per account, so it is read once outside
      // the per-account loop and applies to every account's card: a wedged retention sweep is
      // everyone's problem, not the tenant's whose turn it happened to be.
      // The verdict is kept WHOLE (reason + observed value + threshold) and the reason set
      // derived from it, rather than the other way round. The card deliberately carries only the
      // reasons — its payload is its dedup identity, so a fluctuating number in it would re-toast
      // the inbox every sweep — but the outbound alert is an EDGE, stored nowhere, and the
      // numbers that tripped are exactly what an on-call receiver routes on.
      const alerts = evaluatePlatformHealth(snapshot, account.thresholds, worstSweep)
      const reasons = platformAlertReasons(alerts)
      // The workspaces whose card would actually change state this pass. A healthy workspace
      // with no card, and an unhealthy one whose firing set is unchanged, are both no-ops.
      const changing = workspaceIds.filter((id) =>
        reasons.length > 0 ? !sameReasonSet(openCards.get(id), reasons) : openCards.has(id),
      )
      if (changing.length === 0) continue
      // The failing runs the card deep-links to, fetched ONCE for the account and only when
      // something is actually being raised on a run-evidenced condition, so the steady state
      // (nothing changing, or a backlog/stall alert with no failures behind it) costs nothing.
      const evidence =
        reasons.length > 0 && alertsHaveRunEvidence(reasons)
          ? await readFailingRuns(observability, accountId, snapshot.since, logger)
          : undefined
      for (const workspaceId of changing) {
        const settled = await settleWorkspace(
          { notifications: notifications.service, alertSink: container.platformAlertSink, logger },
          {
            workspaceId,
            accountId,
            window: account.window,
            alerts,
            reasons,
            evidence,
          },
        )
        if (settled === 'raised') raised += 1
        else if (settled === 'cleared') cleared += 1
      }
    } catch (err) {
      logger?.warn('platform-health: failed to evaluate account', {
        scope: 'platform-health',
        accountId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { raised, cleared }
}

/** What one workspace's pass did, for the sweep's counters. */
type WorkspaceOutcome = 'raised' | 'cleared' | 'none'

/** The collaborators {@link settleWorkspace} needs, bound once per pass. */
interface SettleDeps {
  notifications: NonNullable<ServerContainer['notifications']>['service']
  /** The outbound on-call push. Absent ⇒ no endpoint feature is wired; the card still lands. */
  alertSink?: PlatformAlertSink
  logger?: Logger
}

/** The account's verdict, as it applies to one of its workspaces. */
interface SettleInput {
  workspaceId: string
  accountId: string
  window: PlatformAlertWindow
  /** The firing conditions with their observed values; EMPTY ⇒ the account has recovered. */
  alerts: PlatformAlert[]
  /** The same conditions as the card's sorted reason set (its dedup identity). */
  reasons: PlatformAlertReason[]
  /** The account-wide failing-run sample, or undefined when there was none to read (or it failed). */
  evidence: PlatformFailedRunRef[] | undefined
}

/**
 * Apply the account's verdict to ONE workspace: raise or clear its `platform_health` card, then
 * push the matching edge to the workspace's registered endpoint.
 *
 * The order is deliberate and matches the run-lifecycle rule next door: the local write commits
 * FIRST and the outbound call runs behind it, so a receiver's outage costs the notification and
 * never the platform's own record of the alert.
 *
 * The card is also what supplies the edge's identity, which is the other half of why this is one
 * function rather than two. The sweep's alert state IS the card row: `raise` reuses an open card's
 * id while an incident lasts and mints a new one for the next incident, so the id is exactly the
 * incident key a receiver dedupes on, and `clearByType` returning null is exactly "there was
 * nothing open, so no recovery happened here".
 */
async function settleWorkspace(deps: SettleDeps, input: SettleInput): Promise<WorkspaceOutcome> {
  const { workspaceId, accountId, window, alerts, reasons, evidence } = input
  if (reasons.length > 0) {
    const { title, body } = platformHealthCardContent(reasons, window)
    const failingRuns = evidence ? failingRunsFor(evidence, workspaceId) : []
    const workspaceFailedTotal = evidence?.find(
      (r) => r.workspaceId === workspaceId,
    )?.workspaceFailedTotal
    const card = await deps.notifications.raise(workspaceId, {
      type: 'platform_health',
      blockId: null,
      executionId: null,
      title,
      body,
      payload: {
        platformWindow: window,
        platformAlerts: reasons,
        // Both omitted when there is nothing to link: an empty list and an absent one
        // would render the same, and only the absence is honest about a condition that
        // has no failing run behind it in the first place.
        ...(failingRuns.length > 0
          ? {
              platformFailingRuns: failingRuns,
              // Every row of a workspace's partition carries that workspace's full
              // failed count, so the cap can say "5 of 23" without a second query.
              platformFailedTotal: workspaceFailedTotal ?? failingRuns.length,
            }
          : {}),
      },
    })
    await announce(deps, workspaceId, {
      event: 'platform_health.firing',
      cardId: card.id,
      accountId,
      window,
      conditions: alerts.map((alert) => ({
        reason: alert.reason,
        value: alert.value,
        threshold: alert.threshold,
      })),
      occurredAt: card.createdAt,
      failingRuns,
      // Absent evidence is NOT zero: a backlog alert has no failing runs behind it, an evidence
      // read that failed has none it could see, and a workspace where nothing failed has none
      // because nothing failed. Only the last of those is a number, so the other two say null.
      failedTotal: workspaceFailedTotal ?? (failingRuns.length > 0 ? failingRuns.length : null),
    })
    return 'raised'
  }

  const dismissed = await deps.notifications.clearByType(workspaceId, 'platform_health')
  if (!dismissed) return 'none'
  await announce(deps, workspaceId, {
    event: 'platform_health.resolved',
    cardId: dismissed.id,
    accountId,
    window,
    conditions: [],
    occurredAt: dismissed.resolvedAt ?? dismissed.createdAt,
    failingRuns: [],
    failedTotal: null,
  })
  return 'cleared'
}

/**
 * Push one edge to the workspace's endpoint, behind the sweep's own best-effort seam.
 *
 * The sink swallows a receiver's outage by contract, so this second net is about the sink itself:
 * a facade-supplied implementation that violates that contract must not be able to abort the
 * account's remaining workspaces, because the failure mode would be a deployment that stops
 * watching itself the moment one tenant's pager endpoint misbehaves. Swallowed, never silent —
 * `runBestEffort` names the drop with the cause attached.
 */
async function announce(
  deps: SettleDeps,
  workspaceId: string,
  event: PlatformAlertEvent,
): Promise<void> {
  const sink = deps.alertSink
  if (!sink) return
  await runBestEffort(
    deps.logger ?? noopLogger,
    'platform-health.alertDelivery',
    () => sink.platformHealthChanged(workspaceId, event),
    { scope: 'platform-health', workspaceId, accountId: event.accountId, event: event.event },
  )
}

/**
 * The failing-run sample, or undefined when it could not be read.
 *
 * Its own try/catch, INSIDE the per-account one, because the deep link is an enhancement to
 * the alert and the alert is the thing that matters: letting this failure reach the handler
 * above would suppress the card entirely, so a bad evidence query would mean an unhealthy
 * deployment stopped telling anyone it was unhealthy. The card still fires, without links, and
 * the drop is named rather than silent.
 */
async function readFailingRuns(
  observability: NonNullable<ServerContainer['platformObservability']>,
  accountId: string,
  since: number,
  logger?: Logger,
): Promise<PlatformFailedRunRef[] | undefined> {
  try {
    return await observability.failingRuns(accountId, since, FAILING_RUN_SAMPLE)
  } catch (error) {
    logger?.warn('platform-health: could not read the failing runs behind the alert', {
      scope: 'platform-health',
      accountId,
      ...describeError(error),
    })
    return undefined
  }
}

/**
 * The account's stored alert overrides, or undefined when nothing is stored, the settings
 * module is not wired, or the row cannot be read.
 *
 * The failure is caught HERE rather than left to the per-account handler above, and that
 * placement is the point: an unreadable settings row must cost the account its OVERRIDES, not
 * its alerting. Letting it propagate would mean a sealed-blob problem (a rotated encryption
 * key, say) silently switched off the very watcher that is supposed to notice things going
 * wrong, and it would do so on exactly the deployment where something already has. Falling
 * back to the deployment defaults matches how `parseStoredAccountSettingsConfig` treats a
 * malformed blob: unreadable is not a policy.
 */
async function readAccountAlertSettings(
  container: ServerContainer,
  accountId: string,
  logger?: Logger,
): Promise<PlatformAlertSettings | undefined> {
  const settings = container.accountSettings
  if (!settings) return undefined
  try {
    return (await settings.service.resolve(accountId)).config.platformAlerts
  } catch (error) {
    logger?.warn('platform-health: account alert settings unreadable; using deployment defaults', {
      scope: 'platform-health',
      accountId,
      ...describeError(error),
    })
    return undefined
  }
}
