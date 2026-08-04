import {
  alertsHaveRunEvidence,
  distinctAccountIds,
  evaluatePlatformHealth,
  platformAlertReasons,
  platformHealthCardContent,
  resolveAccountAlertConfig,
} from '@cat-factory/orchestration'
import type {
  PlatformAlertReason,
  PlatformAlertSettings,
  PlatformFailingRun,
} from '@cat-factory/contracts'
import type { ServerContainer } from '../http/env.js'
import type { Logger, Notification, PlatformFailedRunRef } from '@cat-factory/kernel'
import { describeError } from '@cat-factory/kernel'
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
      const reasons = platformAlertReasons(
        evaluatePlatformHealth(snapshot, account.thresholds, worstSweep),
      )
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
        if (reasons.length > 0) {
          const { title, body } = platformHealthCardContent(reasons, account.window)
          const failingRuns = evidence ? failingRunsFor(evidence, workspaceId) : []
          await notifications.service.raise(workspaceId, {
            type: 'platform_health',
            blockId: null,
            executionId: null,
            title,
            body,
            payload: {
              platformWindow: account.window,
              platformAlerts: reasons,
              // Both omitted when there is nothing to link: an empty list and an absent one
              // would render the same, and only the absence is honest about a condition that
              // has no failing run behind it in the first place.
              ...(failingRuns.length > 0
                ? {
                    platformFailingRuns: failingRuns,
                    // Every row of a workspace's partition carries that workspace's full
                    // failed count, so the cap can say "5 of 23" without a second query.
                    platformFailedTotal:
                      evidence?.find((r) => r.workspaceId === workspaceId)?.workspaceFailedTotal ??
                      failingRuns.length,
                  }
                : {}),
            },
          })
          raised += 1
        } else if (await notifications.service.clearByType(workspaceId, 'platform_health')) {
          cleared += 1
        }
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
