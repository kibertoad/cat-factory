import type { Notification, NotificationType } from '../domain/types.js'

// Persistence port for notifications (the canonical store behind the in-app
// inbox). The worker implements it against D1; tests supply an in-memory fake.
// Rows are scoped by workspace and keyed by notification id.

export interface NotificationRepository {
  /** A notification by id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<Notification | null>
  /** All currently-open notifications for a workspace (newest first), for the inbox + snapshot. */
  listOpen(workspaceId: string): Promise<Notification[]>
  /**
   * The open notification of `type` for `blockId`, if any — used to de-duplicate so
   * a re-driven run doesn't stack identical cards on the same block.
   */
  findOpenByBlock(
    workspaceId: string,
    blockId: string,
    type: NotificationType,
  ): Promise<Notification | null>
  /**
   * The open, BLOCK-LESS notification of `type` for a workspace (`block_id IS NULL`), if any.
   * The block-less analogue of {@link findOpenByBlock}: it de-duplicates deployment/workspace-
   * wide cards that aren't about any one block (today `platform_health`) so a periodic sweep
   * re-raising the same card reuses the existing open row instead of stacking a new one each
   * pass. Newest first; block-SCOPED cards of the same type are never returned.
   */
  findOpenByType(workspaceId: string, type: NotificationType): Promise<Notification | null>
  /**
   * BATCHED {@link findOpenByType}: the open, block-less card of `type` for EACH of
   * `workspaceIds` that has one, as a `Map<workspaceId, Notification>` (newest per workspace;
   * workspaces with none are simply absent). The platform-health sweep enumerates every
   * workspace and would otherwise `findOpenByType` per workspace inside the loop — an N+1 that
   * runs every couple of minutes across the whole deployment. One chunked-`IN` read here lets
   * the sweep skip the point-read for the (steady-state common) healthy workspaces that hold no
   * card, mirroring `WorkspaceSettingsRepository.listByWorkspaceIds` in the escalation sweep.
   * Empty input → empty map.
   */
  listOpenByType(workspaceIds: string[], type: NotificationType): Promise<Map<string, Notification>>
  /** Create or replace a notification (keyed by id). Used for status transitions
   * (dismiss/act/escalate) and block-less cards. */
  upsert(workspaceId: string, notification: Notification): Promise<void>
  /**
   * ATOMICALLY claim an OPEN notification for its action: flip `open` → `acted` (stamping
   * `resolvedAt`) in ONE conditional statement and return the claimed row, or `null` when the
   * card was NOT open (already acted/dismissed, or gone). The `act` double-fire guard — two
   * concurrent acts on the same card (double-click, two members' inboxes, an HTTP retry) race
   * here and only the winner gets the row back, so the notification's side effect (merge the
   * PR / retry the run) runs EXACTLY once; the loser sees `null` and skips it. Modeled on
   * {@link PasswordResetTokenRepository.consume}. The service reverts to `open` (via `upsert`)
   * if the side effect then throws, so a failed action stays retryable.
   */
  claimForAction(workspaceId: string, id: string, resolvedAt: number): Promise<Notification | null>
  /**
   * ATOMICALLY create-or-refresh the SINGLE open notification of `notification.type` for
   * its block, enforced by a partial unique index on `(workspace_id, block_id, type)`
   * WHERE status='open'. Block-scoped `raise()` routes here so two concurrent raises can't
   * stack duplicate open cards (the read-before-write race in {@link findOpenByBlock} →
   * build → upsert): the existing open row is updated in place, preserving its id,
   * `createdAt`, and already-escalated `severity`. Requires `notification.blockId` to be set.
   *
   * Returns the CANONICAL persisted row (its real id, preserved severity/createdAt) — NOT
   * the caller's optimistic in-memory copy. When a concurrent raise wins the insert, the
   * loser's in-memory id is discarded here, so `raise()` delivers and returns the one row
   * that actually exists; otherwise the loser would push a phantom-id card the inbox can't
   * resolve (a 404 on action) and the dedup would leak back at the delivery layer.
   */
  upsertOpenForBlock(workspaceId: string, notification: Notification): Promise<Notification>
  /**
   * Escalate every open, still-`normal` (or severity-less) notification created at or
   * before `cutoff` to `urgent`, in ONE statement (the escalation sweep's write — never a
   * per-row upsert loop), returning the escalated notifications so the caller can
   * re-deliver each for the real-time inbox re-render. Nothing matches → empty array.
   */
  escalateStaleOpen(workspaceId: string, cutoff: number): Promise<Notification[]>
  /**
   * Prune resolved notifications (status `acted`/`dismissed`) whose `resolvedAt` is at or
   * before `cutoff`, across all workspaces, returning the number of rows removed. The
   * retention sweep's write for the otherwise-unbounded `notifications` table: a busy
   * workspace raises a card on every waiting/decision/park event, and resolved rows would
   * accumulate forever otherwise. `open` cards are the actionable inbox and are NEVER
   * touched — only terminal rows past the window are deleted (a row with a null
   * `resolvedAt` is likewise kept, since it can't be placed in the window).
   */
  deleteResolvedOlderThan(cutoff: number): Promise<number>
}
