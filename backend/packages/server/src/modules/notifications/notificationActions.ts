import type { Notification, NotificationType, ReviewEffort } from '@cat-factory/contracts'
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
  // `merge_tag_request` is deliberately ABSENT: its whole action is recording a reviewer-effort
  // tag the human chose, and the headless `act` route carries no tag — so admitting it would
  // resolve the nudge while recording nothing. A headless caller tags through
  // `POST /api/v1/merge-records/:recordId/effort` (the record id is on the card's payload), then
  // dismisses the card. That route is `write`, a rung BELOW the `admin` this one needs, since
  // tagging a pull request that already landed merges nothing.
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
 *
 * `reviewEffort` — supplied by the merge card's one-tap confirm-and-tag — records onto the run's
 * merge track record how much review the PR actually needed. It is ALWAYS optional (a headless
 * caller omits it entirely): an untagged merge records a null tag and nothing downstream breaks.
 */
export function notificationActEffect(
  container: ServerContainer,
  workspaceId: string,
  userId: string | null | undefined,
  reviewEffort?: ReviewEffort | null,
): (notification: Notification) => Promise<void> {
  return async (notification) => {
    switch (notification.type) {
      case 'merge_review':
      case 'pipeline_complete':
        if (notification.blockId) {
          await runWithInitiator({ workspaceId, initiatedBy: userId }, () =>
            container.executionService.mergePr(workspaceId, notification.blockId!, reviewEffort),
          )
        }
        break
      case 'merge_tag_request':
        // A post-hoc nudge for a PR that already merged externally: there is nothing to merge, so
        // acting on it ONLY records the tag (when the human picked one). The record id travels on
        // the card because an external merge has no run the block lookup would find reliably.
        if (reviewEffort !== undefined && notification.payload?.mergeTrackRecordId) {
          await container.mergeTrackRecords?.service.tag(
            workspaceId,
            notification.payload.mergeTrackRecordId,
            reviewEffort,
          )
        }
        break
      case 'ci_failed':
      case 'test_failed':
        if (notification.executionId) {
          await container.executionService.retry(workspaceId, notification.executionId)
        }
        break
      case 'key_drift':
        // ADR 0026 D6.3: acting on a key-drift card drops EVERY unrecoverable credential it
        // lists (the "drop all stale" batch), flipping each owning connection to needs-re-entry.
        // A single credential is dropped from the operator CLI instead. Explicit + confirmed on
        // the card — the values are gone under the old key, so this never runs automatically.
        if (container.sealedSecretInventory) {
          for (const ref of notification.payload?.driftAffected ?? []) {
            await container.sealedSecretInventory.drop({ source: ref.source, id: ref.id })
          }
        }
        break
    }
  }
}
