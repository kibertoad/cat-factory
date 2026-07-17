import {
  distinctAccountIds,
  evaluatePlatformHealth,
  platformAlertReasons,
  platformHealthCardContent,
} from '@cat-factory/orchestration'
import type { ServerContainer } from '../http/env.js'

// Runtime-neutral platform-health ALERT sweep — the push counterpart to the operator dashboard
// read, shared by both facades' periodic sweeps (the Worker's cron `scheduled` handler and the
// Node `setInterval` sweeper), exactly like `escalateStaleNotifications`. It evaluates each
// account's aggregate run-health projection (the SAME `PlatformObservabilityService.summarize`
// the dashboard reads — no new SQL) against the deployment thresholds and, per account:
//   - raises ONE `platform_health` notification per workspace when a ceiling is crossed, or
//   - clears the open card when the account has recovered.
// The card de-dupes on (workspace, type) and its content is a pure function of the FIRING
// reason set, so a persistently-unhealthy deployment re-notifies only when the set changes
// (the "state-change dedup, not every sweep" requirement), not on every pass.
//
// A no-op unless alerting is opted in AND both the notifications module and the platform-
// observability read are wired (tests / no telemetry DB / mothership local nodes). Best-effort
// per account: a failed summarize/raise for one account is logged and skipped, never aborting
// the others — this sweep must not become the silent background failure it exists to catch.

/** Minimal structured logger (pino-compatible); optional. */
export interface PlatformHealthSweepLogger {
  warn(obj: Record<string, unknown>, msg?: string): void
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
  logger?: PlatformHealthSweepLogger,
): Promise<{ raised: number; cleared: number }> {
  const cfg = container.config.platformAlerts
  const notifications = container.notifications
  const observability = container.platformObservability
  if (!cfg.enabled || !notifications || !observability) return { raised: 0, cleared: 0 }

  const workspaces = await container.workspaceService.list(null)
  // Group workspaces by account so each account is summarized ONCE (five GROUP BY queries),
  // then the verdict is fanned to every workspace in the account. Legacy null-account boards
  // are skipped: the platform-metrics read is account-scoped (matches `distinctAccountIds`).
  const byAccount = new Map<string, string[]>()
  for (const ws of workspaces) {
    if (!ws.accountId) continue
    const list = byAccount.get(ws.accountId)
    if (list) list.push(ws.id)
    else byAccount.set(ws.accountId, [ws.id])
  }

  // Which workspaces already hold an open `platform_health` card, learned in ONE batched read
  // up front rather than a `findOpenByType` point-read per workspace inside the loop (that N+1
  // would run across the whole deployment every sweep — every couple of minutes). A healthy
  // workspace with no card is the steady-state common case, and it is now skipped entirely: we
  // only touch `clearByType` for a workspace that actually has a card to clear.
  const withOpenCard = new Set(
    (
      await notifications.service.listOpenByType(
        workspaces.map((ws) => ws.id),
        'platform_health',
      )
    ).keys(),
  )

  let raised = 0
  let cleared = 0
  for (const accountId of distinctAccountIds(workspaces)) {
    const workspaceIds = byAccount.get(accountId) ?? []
    try {
      const snapshot = await observability.summarize(accountId, cfg.window)
      const reasons = platformAlertReasons(evaluatePlatformHealth(snapshot, cfg.thresholds))
      for (const workspaceId of workspaceIds) {
        if (reasons.length > 0) {
          const { title, body } = platformHealthCardContent(reasons, cfg.window)
          await notifications.service.raise(workspaceId, {
            type: 'platform_health',
            blockId: null,
            executionId: null,
            title,
            body,
            payload: { platformWindow: cfg.window, platformAlerts: reasons },
          })
          raised += 1
        } else if (
          withOpenCard.has(workspaceId) &&
          (await notifications.service.clearByType(workspaceId, 'platform_health'))
        ) {
          cleared += 1
        }
      }
    } catch (err) {
      logger?.warn(
        {
          scope: 'platform-health',
          accountId,
          err: err instanceof Error ? err.message : String(err),
        },
        'platform-health: failed to evaluate account',
      )
    }
  }
  return { raised, cleared }
}
