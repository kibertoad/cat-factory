import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import type { ServerContainer } from '../http/env.js'

/**
 * Escalate long-waiting open notifications from `normal` (yellow) to `urgent` (red)
 * across every workspace. Shared by both runtime facades' periodic sweeps (the Worker's
 * cron `scheduled` handler and the Node `setInterval` sweeper), so the run-timing signal
 * that replaced the old decision timeout behaves identically on both. Per workspace it
 * resolves the `waitingEscalationMinutes` threshold (falling back to the default when the
 * settings module isn't wired) and asks the notification service to escalate. Returns the
 * total number escalated. A no-op when the notifications module isn't configured.
 *
 * The per-workspace escalation threshold is resolved in ONE batched read before the loop
 * (`settings.service.getMany`) rather than a `get` point-read per workspace — this sweep
 * runs every couple of minutes across every workspace on both facades, and the perf-item-9
 * settings cache is pass-through on the Worker profile, so only a batch read avoids the N+1
 * here.
 */
export async function escalateStaleNotifications(
  container: ServerContainer,
  now: number,
): Promise<number> {
  const notifications = container.notifications
  if (!notifications) return 0
  const settings = container.settings
  const workspaces = await container.workspaceService.list(null)
  const settingsById = settings
    ? await settings.service.getMany(workspaces.map((ws) => ws.id))
    : null
  let escalated = 0
  for (const ws of workspaces) {
    const cfg = settingsById?.get(ws.id) ?? DEFAULT_WORKSPACE_SETTINGS
    const thresholdMs = cfg.waitingEscalationMinutes * 60_000
    escalated += await notifications.service.escalateStale(ws.id, thresholdMs, now)
  }
  return escalated
}
