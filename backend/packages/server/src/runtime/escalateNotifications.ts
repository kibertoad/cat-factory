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
 */
export async function escalateStaleNotifications(
  container: ServerContainer,
  now: number,
): Promise<number> {
  const notifications = container.notifications
  if (!notifications) return 0
  const settings = container.settings
  const workspaces = await container.workspaceService.list(null)
  let escalated = 0
  for (const ws of workspaces) {
    const cfg = settings ? await settings.service.get(ws.id) : DEFAULT_WORKSPACE_SETTINGS
    const thresholdMs = cfg.waitingEscalationMinutes * 60_000
    escalated += await notifications.service.escalateStale(ws.id, thresholdMs, now)
  }
  return escalated
}
