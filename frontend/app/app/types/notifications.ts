// Notification shapes. A notification is a first-class, human-actionable item
// surfaced on the board that outlives the run that raised it (a PR awaiting a
// merge decision, a completed pipeline awaiting confirmation, CI that gave up).
//
// All wire shapes are sourced from @cat-factory/contracts (single source of
// truth). The historical frontend name `ReleaseSignal` is the contract's
// `ReleaseSignalWire`.

export type {
  NotificationType,
  NotificationDeliveryChannel,
  NotificationChannelOverrides,
  NotificationRoutingMatrix,
  NotificationSettings,
  NotificationStatus,
  OnCallRecommendation,
  OnCallAssessment,
  NotificationPayload,
  NotificationSeverity,
  Notification,
  ReleaseSignalWire as ReleaseSignal,
} from '@cat-factory/contracts'

/**
 * How the notification-manager settings load ENDED. Client-only (it describes the fetch, not a
 * wire shape), and deliberately four states rather than a nullable boolean:
 *
 * - `unloaded` / `loading`: nothing to render a grid from yet.
 * - `ready`: `settings` holds the board's own matrix.
 * - `unavailable`: SETTLED. This deployment wired no routing store, so the shipped defaults are
 *   the whole truth and there is nothing to edit.
 * - `failed`: the read broke, so the board's configuration is UNKNOWN. Distinct from
 *   `unavailable` because the panel must not offer a save: the write is a full replace, and
 *   saving a grid built from defaults would overwrite overrides nobody looked at.
 */
export type NotificationSettingsStatus = 'unloaded' | 'loading' | 'ready' | 'unavailable' | 'failed'
