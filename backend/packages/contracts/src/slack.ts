import * as v from 'valibot'
import { notificationTypeSchema } from './notifications.js'

// ---------------------------------------------------------------------------
// Slack integration wire contracts.
//
// Slack is an additional *delivery transport* for the existing notification
// mechanism (merge_review / pipeline_complete / ci_failed) — not a parallel
// system. A `SlackNotificationChannel` implements the same `NotificationChannel`
// port the in-app channel does, composed in via `CompositeNotificationChannel`,
// so the call sites that raise notifications are untouched.
//
// Two scopes, mirroring the GitHub-App precedent:
//   - The Slack *connection* (a workspace/team install + its bot token) is
//     bound PER-ACCOUNT — an org installs the Slack app once. The bot token is
//     multi-tenant data, so it is encrypted at rest (WebCryptoSecretCipher,
//     `cat-factory:slack`) and NEVER returned on the wire; only safe metadata
//     (team name/icon, bot user, scopes) is exposed.
//   - Notification *routing* (which types post, and to which channel) is
//     configured PER-WORKSPACE.
//   - Optional @-mentions resolve from an opt-in per-account map of GitHub user
//     id → Slack member id (cat-factory has no member emails to look up).
// ---------------------------------------------------------------------------

/**
 * A account's Slack connection, as exposed to clients — safe metadata ONLY.
 * The bot token is never part of this shape (it lives encrypted server-side).
 */
export const slackConnectionSchema = v.object({
  /** The Slack team (workspace) id, e.g. `T012AB3C4`. */
  teamId: v.string(),
  /** The Slack team display name. */
  teamName: v.string(),
  /** Team icon URL, when Slack returned one. */
  teamIconUrl: v.optional(v.nullable(v.string())),
  /** The bot user id the app posts as (`auth.test` `user_id`), when known. */
  botUserId: v.optional(v.nullable(v.string())),
  /** OAuth scopes the bot token was granted, when known. */
  scopes: v.optional(v.array(v.string())),
  connectedAt: v.number(),
})
export type SlackConnection = v.InferOutput<typeof slackConnectionSchema>

/** Routing for a single notification type: whether it posts, and where. */
export const slackRouteSchema = v.object({
  enabled: v.boolean(),
  /** A channel id (`C0123…`) or name (`#general`); empty = unrouted. */
  channel: v.pipe(v.string(), v.trim(), v.maxLength(200)),
})
export type SlackRoute = v.InferOutput<typeof slackRouteSchema>

/**
 * A workspace's Slack notification settings: a partial map of notification type
 * → route, plus whether to resolve @-mentions from the account member mapping. A
 * type absent from `routes`, disabled, or with an empty channel does not post.
 */
export const slackNotificationSettingsSchema = v.object({
  routes: v.record(notificationTypeSchema, slackRouteSchema),
  /** Resolve @-mentions from the per-account member mapping when posting. */
  mentionsEnabled: v.boolean(),
  updatedAt: v.number(),
})
export type SlackNotificationSettings = v.InferOutput<typeof slackNotificationSettingsSchema>

/** One GitHub user id → Slack member id mapping entry. */
export const slackMemberMappingEntrySchema = v.object({
  githubUserId: v.number(),
  slackUserId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
})
export type SlackMemberMappingEntry = v.InferOutput<typeof slackMemberMappingEntrySchema>

/** An account's GitHub→Slack member map (opt-in; backs @-mentions). */
export const slackMemberMappingSchema = v.object({
  entries: v.array(slackMemberMappingEntrySchema),
})
export type SlackMemberMapping = v.InferOutput<typeof slackMemberMappingSchema>

/** A Slack channel option for the routing picker (`conversations.list`). */
export const slackChannelSchema = v.object({
  id: v.string(),
  name: v.string(),
  isPrivate: v.boolean(),
})
export type SlackChannel = v.InferOutput<typeof slackChannelSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Connect Slack by pasting a bot token (the always-available fallback to OAuth).
 * The token is write-only: validated via `auth.test`, encrypted, never returned.
 */
export const connectSlackByTokenSchema = v.object({
  token: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type ConnectSlackByTokenInput = v.InferOutput<typeof connectSlackByTokenSchema>

/** Replace a workspace's Slack notification routing. */
export const updateSlackSettingsSchema = v.object({
  routes: v.record(notificationTypeSchema, slackRouteSchema),
  mentionsEnabled: v.boolean(),
})
export type UpdateSlackSettingsInput = v.InferOutput<typeof updateSlackSettingsSchema>

/** Replace an account's GitHub→Slack member mapping. */
export const updateSlackMemberMappingSchema = v.object({
  entries: v.array(slackMemberMappingEntrySchema),
})
export type UpdateSlackMemberMappingInput = v.InferOutput<typeof updateSlackMemberMappingSchema>
