import type { Notification, NotificationType } from '@cat-factory/contracts'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { ServerContainer } from '../../http/env.js'

/**
 * The notification types whose `act` runs an AUTOMATED side-effect (merge the PR / retry the
 * run) rather than merely marking the card read. Every OTHER type is informational or parks a
 * run on an interactive human decision (choose a fork, pick review findings, resolve a
 * decision), so `act`-ing it does nothing but flip the card to `acted`. That is fine for an
 * interactive SPA user, but for a HEADLESS API caller it is a footgun: it would silently hide
 * the reminder while the run stays parked. The public `/api/v1` `act` route therefore admits
 * only this set and steers everything else to `dismiss`. Keep it in step with the `switch`
 * below — a type with a `case` here belongs in this set, and vice versa.
 */
export const HEADLESS_ACTIONABLE_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'merge_review',
  'pipeline_complete',
  'ci_failed',
  'test_failed',
])

/**
 * The typed side-effect of ACTING on a notification, shared by the SPA notification
 * inbox and the `/api/v1` public surface so the two can never drift:
 *
 *   - `merge_review` / `pipeline_complete` → confirm + merge the PR for real (the block
 *     flips `pr_ready` → `done`).
 *   - `ci_failed` / `test_failed` → retry the failed run once CI / the tests are fixed.
 *   - every other (informational) type → no side-effect; `act` just marks it read.
 *
 * The merge runs under the acting user's ambient initiator context so their per-user PAT
 * (when set) does the merge; a HEADLESS caller (the public API has no `usr_*` user) passes
 * `null` and the merge falls back to the deployment's installation token. This lives at the
 * call site (not `NotificationService`) so the service stays free of execution/GitHub
 * concerns; `service.act` runs it exactly once behind its atomic open→acted claim.
 */
export function notificationActEffect(
  container: ServerContainer,
  workspaceId: string,
  userId: string | null | undefined,
): (notification: Notification) => Promise<void> {
  return async (notification) => {
    switch (notification.type) {
      case 'merge_review':
      case 'pipeline_complete':
        if (notification.blockId) {
          await runWithInitiator(userId, () =>
            container.executionService.mergePr(workspaceId, notification.blockId!),
          )
        }
        break
      case 'ci_failed':
      case 'test_failed':
        if (notification.executionId) {
          await container.executionService.retry(workspaceId, notification.executionId)
        }
        break
    }
  }
}
