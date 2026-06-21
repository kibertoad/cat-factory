import type {
  SlackConnectionRecord,
  SlackConnectionRepository,
  SlackMemberMappingEntry,
  SlackMemberMappingRepository,
  SlackSettingsRecord,
  SlackSettingsRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// D1-backed stores for the Slack integration (migration 0037). Three scopes:
// per-account connection (+ encrypted bot token), per-workspace routing, and the
// per-account member map. Behaviourally identical to the Drizzle mirrors so the
// cross-runtime conformance suite asserts the same Slack behaviour on both stores.

interface SlackConnectionRow {
  account_id: string
  team_id: string
  team_name: string
  team_icon_url: string | null
  bot_user_id: string | null
  scopes: string | null
  token_cipher: string
  created_at: number
  deleted_at: number | null
}

function rowToConnection(row: SlackConnectionRow): SlackConnectionRecord {
  return {
    accountId: row.account_id,
    teamId: row.team_id,
    teamName: row.team_name,
    teamIconUrl: row.team_icon_url,
    botUserId: row.bot_user_id,
    scopesJson: row.scopes,
    tokenCipher: row.token_cipher,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

export class D1SlackConnectionRepository implements SlackConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByAccount(accountId: string): Promise<SlackConnectionRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM slack_connections WHERE account_id = ?')
      .bind(accountId)
      .first<SlackConnectionRow>()
    return row ? rowToConnection(row) : null
  }

  async getByTeam(teamId: string): Promise<SlackConnectionRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM slack_connections WHERE team_id = ? AND deleted_at IS NULL')
      .bind(teamId)
      .first<SlackConnectionRow>()
    return row ? rowToConnection(row) : null
  }

  async upsert(record: SlackConnectionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO slack_connections
           (account_id, team_id, team_name, team_icon_url, bot_user_id, scopes, token_cipher, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (account_id) DO UPDATE SET
           team_id = excluded.team_id,
           team_name = excluded.team_name,
           team_icon_url = excluded.team_icon_url,
           bot_user_id = excluded.bot_user_id,
           scopes = excluded.scopes,
           token_cipher = excluded.token_cipher,
           created_at = excluded.created_at,
           deleted_at = NULL`,
      )
      .bind(
        record.accountId,
        record.teamId,
        record.teamName,
        record.teamIconUrl,
        record.botUserId,
        record.scopesJson,
        record.tokenCipher,
        record.createdAt,
      )
      .run()
  }

  async softDelete(accountId: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE slack_connections SET deleted_at = ? WHERE account_id = ? AND deleted_at IS NULL',
      )
      .bind(at, accountId)
      .run()
  }
}

interface SlackSettingsRow {
  workspace_id: string
  routes: string
  mentions_enabled: number
  updated_at: number
}

export class D1SlackSettingsRepository implements SlackSettingsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByWorkspace(workspaceId: string): Promise<SlackSettingsRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM slack_settings WHERE workspace_id = ?')
      .bind(workspaceId)
      .first<SlackSettingsRow>()
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      routesJson: row.routes,
      mentionsEnabled: row.mentions_enabled === 1,
      updatedAt: row.updated_at,
    }
  }

  async upsert(record: SlackSettingsRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO slack_settings (workspace_id, routes, mentions_enabled, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           routes = excluded.routes,
           mentions_enabled = excluded.mentions_enabled,
           updated_at = excluded.updated_at`,
      )
      .bind(record.workspaceId, record.routesJson, record.mentionsEnabled ? 1 : 0, record.updatedAt)
      .run()
  }
}

interface SlackMemberMappingRow {
  account_id: string
  entries: string
  updated_at: number
}

export class D1SlackMemberMappingRepository implements SlackMemberMappingRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByAccount(accountId: string): Promise<SlackMemberMappingEntry[]> {
    const row = await this.db
      .prepare('SELECT * FROM slack_member_mappings WHERE account_id = ?')
      .bind(accountId)
      .first<SlackMemberMappingRow>()
    if (!row) return []
    try {
      const parsed = JSON.parse(row.entries)
      return Array.isArray(parsed) ? (parsed as SlackMemberMappingEntry[]) : []
    } catch {
      return []
    }
  }

  async upsert(accountId: string, entries: SlackMemberMappingEntry[], at: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO slack_member_mappings (account_id, entries, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET
           entries = excluded.entries,
           updated_at = excluded.updated_at`,
      )
      .bind(accountId, JSON.stringify(entries), at)
      .run()
  }
}
