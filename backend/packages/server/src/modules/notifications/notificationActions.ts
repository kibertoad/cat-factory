import type { Notification } from '@cat-factory/contracts'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { ServerContainer } from '../../http/env.js'

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
