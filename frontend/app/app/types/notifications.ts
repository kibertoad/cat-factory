// Notification shapes. A notification is a first-class, human-actionable item
// surfaced on the board that outlives the run that raised it (a PR awaiting a
// merge decision, a completed pipeline awaiting confirmation, CI that gave up).
//
// All wire shapes are sourced from @cat-factory/contracts (single source of
// truth). The historical frontend name `ReleaseSignal` is the contract's
// `ReleaseSignalWire`.

export type {
  NotificationType,
  NotificationStatus,
  OnCallRecommendation,
  OnCallAssessment,
  NotificationPayload,
  NotificationSeverity,
  Notification,
  ReleaseSignalWire as ReleaseSignal,
} from '@cat-factory/contracts'
