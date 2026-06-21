import type { SlackMemberMappingEntry, SlackNotificationSettings } from '../domain/types.js'

// Persistence ports for the Slack integration. Each runtime implements these
// against its store (Cloudflare D1 / Node Postgres); both are exercised by the
// cross-runtime conformance suite. Two scopes mirror how Slack is configured:
//   - the connection (+ encrypted bot token) is keyed PER-ACCOUNT,
//   - the notification routing is keyed PER-WORKSPACE,
//   - the optional GitHub→Slack member map is keyed PER-ACCOUNT.
// The bot token is stored as opaque ciphertext (see the SecretCipher port); these
// records never hold plaintext tokens.

/**
 * An account's Slack connection: the installed team metadata + the encrypted bot
 * token. The token is decrypted only in-memory, at delivery time, by the channel.
 */
export interface SlackConnectionRecord {
  accountId: string
  teamId: string
  teamName: string
  teamIconUrl: string | null
  botUserId: string | null
  /** OAuth scopes granted to the bot token, as a JSON array string (or null). */
  scopesJson: string | null
  /** Ciphertext of the bot token (SecretCipher envelope); never plaintext. */
  tokenCipher: string
  createdAt: number
  /** Set when the account disconnects Slack (tombstone). */
  deletedAt: number | null
}

export interface SlackConnectionRepository {
  /** The account's live connection, or null if not connected. */
  getByAccount(accountId: string): Promise<SlackConnectionRecord | null>
  /**
   * The live connection bound to a Slack team, or null — used to guard against a
   * team being claimed by a second account (mirrors the GitHub-installation guard).
   */
  getByTeam(teamId: string): Promise<SlackConnectionRecord | null>
  /** Create or replace the live connection for an account. */
  upsert(record: SlackConnectionRecord): Promise<void>
  /** Tombstone the account's connection. */
  softDelete(accountId: string, at: number): Promise<void>
}

/** A workspace's Slack notification routing (persisted settings). */
export interface SlackSettingsRecord {
  workspaceId: string
  /** The `SlackNotificationSettings.routes` map, serialized as JSON. */
  routesJson: string
  /** Whether to resolve @-mentions from the account member map (0/1 on D1). */
  mentionsEnabled: boolean
  updatedAt: number
}

export interface SlackSettingsRepository {
  /** A workspace's settings, or null when never configured (defaults apply). */
  getByWorkspace(workspaceId: string): Promise<SlackSettingsRecord | null>
  /** Create or replace a workspace's settings. */
  upsert(record: SlackSettingsRecord): Promise<void>
}

/** An account's opt-in GitHub-user-id → Slack-member-id map. */
export interface SlackMemberMappingRecord {
  accountId: string
  /** The `SlackMemberMapping.entries` array, serialized as JSON. */
  entriesJson: string
  updatedAt: number
}

export interface SlackMemberMappingRepository {
  /** An account's mapping entries (empty when none configured). */
  getByAccount(accountId: string): Promise<SlackMemberMappingEntry[]>
  /** Create or replace an account's mapping. */
  upsert(accountId: string, entries: SlackMemberMappingEntry[], at: number): Promise<void>
}

/** Re-exported for repository implementations that map the persisted settings. */
export type { SlackNotificationSettings }
