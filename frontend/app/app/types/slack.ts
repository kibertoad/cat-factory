// ---------------------------------------------------------------------------
// Slack integration. Slack is an extra delivery transport for the existing
// notification mechanism (merge_review / pipeline_complete / ci_failed), tapping
// the same NotificationChannel seam server-side. These mirror the
// `@cat-factory/contracts` Slack schemas so responses drop straight into the store.
//
// Two scopes: the connection (+ bot token, never sent here) is per-account; the
// notification routing is per-workspace; the @-mention member map is per-account.
// ---------------------------------------------------------------------------

import type { NotificationType } from './notifications'

/** An account's Slack connection, as exposed to clients — safe metadata only. */
export interface SlackConnection {
  teamId: string
  teamName: string
  teamIconUrl?: string | null
  botUserId?: string | null
  scopes?: string[]
  connectedAt: number
}

/** Routing for a single notification type: whether it posts, and where. */
export interface SlackRoute {
  enabled: boolean
  /** A channel id (`C0123…`) or name (`#general`); empty = unrouted. */
  channel: string
}

/** A workspace's Slack notification routing. */
export interface SlackNotificationSettings {
  routes: Partial<Record<NotificationType, SlackRoute>>
  mentionsEnabled: boolean
  updatedAt: number
}

/** One GitHub user id → Slack member id mapping entry. */
export type SlackMemberRole = 'product' | 'engineering'

export interface SlackMemberMappingEntry {
  githubUserId: number
  slackUserId: string
  /**
   * Notification role: `product` people are @-mentioned on requirement-review
   * findings; everyone else (`engineering`) only when they created the task.
   * Absent means `engineering`.
   */
  role?: SlackMemberRole
}

/** A Slack channel option for the routing picker. */
export interface SlackChannel {
  id: string
  name: string
  isPrivate: boolean
}
