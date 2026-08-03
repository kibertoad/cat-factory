import { bigint, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// The Slack integration's tables (mirror of D1 migration 0037), split out of `schema.ts` when
// that file hit its size ratchet: one cohesive integration — a per-account connection, its
// per-workspace routing, and the per-account GitHub→Slack member map — with no reference to
// any other table, so it is the seam that costs the least to cross.
//
// Re-exported from `schema.ts`, which stays the single module drizzle-kit reads and every
// repository imports, so nothing else moved.

// Slack integration (mirror of D1 migration 0037). An additional delivery transport
// for the notification mechanism. Per-account connection (+ encrypted bot token,
// `token_cipher` is a WebCryptoSecretCipher envelope, never plaintext), per-workspace
// routing, and the per-account GitHub→Slack member map for @-mentions.
export const slackConnections = pgTable(
  'slack_connections',
  {
    account_id: text('account_id').primaryKey(),
    team_id: text('team_id').notNull(),
    team_name: text('team_name').notNull(),
    team_icon_url: text('team_icon_url'),
    bot_user_id: text('bot_user_id'),
    scopes: text('scopes'),
    token_cipher: text('token_cipher').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    deleted_at: bigint('deleted_at', { mode: 'number' }),
  },
  // A Slack team binds to at most one live account (mirrors the D1 partial unique).
  (t) => [
    uniqueIndex('idx_slack_conn_team')
      .on(t.team_id)
      .where(sql`deleted_at IS NULL`),
  ],
)

export const slackSettings = pgTable('slack_settings', {
  workspace_id: text('workspace_id').primaryKey(),
  routes: text('routes').notNull().default('{}'),
  mentions_enabled: integer('mentions_enabled').notNull().default(0),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const slackMemberMappings = pgTable('slack_member_mappings', {
  account_id: text('account_id').primaryKey(),
  entries: text('entries').notNull().default('[]'),
  updated_at: bigint('updated_at', { mode: 'number' }).notNull(),
})
