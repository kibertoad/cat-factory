// ---------------------------------------------------------------------------
// Slack integration. Slack is an extra delivery transport for the existing
// notification mechanism (merge_review / pipeline_complete / ci_failed), tapping
// the same NotificationChannel seam server-side. These mirror the
// `@cat-factory/contracts` Slack schemas so responses drop straight into the store.
//
// Two scopes: the connection (+ bot token, never sent here) is per-account; the
// notification routing is per-workspace; the @-mention member map is per-account.
// ---------------------------------------------------------------------------
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  SlackConnection,
  SlackRoute,
  SlackNotificationSettings,
  SlackMemberRole,
  SlackMemberMappingEntry,
  SlackChannel,
} from '@cat-factory/contracts'
