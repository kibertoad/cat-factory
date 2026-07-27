import type { MergeTrackRecordService } from './MergeTrackRecordService.js'
import type { NotificationService } from '../notifications/NotificationService.js'

export interface ExternalMergeObserverDeps {
  trackRecord: MergeTrackRecordService
  /** Absent ⇒ the record is still attributed, just without the tag-request nudge. */
  notifications?: NotificationService
}

/**
 * Build the observer the GitHub/GitLab webhook ingest calls when a pull request is merged
 * OUTSIDE cat-factory — a human clicking merge on the provider rather than acting on the
 * merge-review card. Two things follow:
 *
 *  1. The run's merge track record is attributed `external_merged` (it would otherwise sit at
 *     `pending_review` forever, overstating the class's un-decided share).
 *  2. A `merge_tag_request` card asks for the one-tap reviewer-effort tag that the merge card
 *     would have collected. It is a NUDGE: dismissible, gates nothing, and the record stays
 *     perfectly valid untagged.
 *
 * `recordExternalMerge` returns a record ONLY on the delivery that actually flipped it, so a
 * webhook redelivery — or the echo of cat-factory's own merge — raises no duplicate card.
 *
 * Lives in orchestration (not integrations) because it spans the track record and the
 * notification inbox; the webhook service itself sees only a narrow
 * `(workspaceId, repoId, prNumber)` callback and knows nothing about either.
 */
export function makeExternalMergeObserver(
  deps: ExternalMergeObserverDeps,
): (workspaceId: string, repoId: string, prNumber: number) => Promise<void> {
  return async (workspaceId, repoId, prNumber) => {
    const record = await deps.trackRecord.recordExternalMerge(workspaceId, repoId, prNumber)
    if (!record) return
    await deps.notifications?.raise(workspaceId, {
      type: 'merge_tag_request',
      blockId: record.blockId,
      executionId: record.executionId,
      title: 'How much review did that PR need?',
      body:
        `This PR was merged directly on the provider, so its review effort was not recorded. ` +
        `One tap tells the merge policy how much review a ${record.changeClass} change actually ` +
        `needed — or dismiss this card.`,
      payload: {
        ...(record.prUrl ? { prUrl: record.prUrl } : {}),
        ...(record.changeClass !== 'unknown' ? { changeClass: record.changeClass } : {}),
        mergeTrackRecordId: record.id,
      },
    })
  }
}
