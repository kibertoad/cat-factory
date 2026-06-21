import type {
  SlackConnectionRecord,
  SlackConnectionRepository,
  SlackMemberMappingEntry,
  SlackMemberMappingRepository,
  SlackSettingsRecord,
  SlackSettingsRepository,
} from '@cat-factory/kernel'
import { and, eq, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { slackConnections, slackMemberMappings, slackSettings } from '../db/schema.js'

// Drizzle/Postgres mirrors of the Slack D1 repositories (migration 0037). Three
// scopes: per-account connection (+ encrypted bot token), per-workspace routing,
// and the per-account member map. Behaviourally identical to the D1 repos so the
// cross-runtime conformance suite asserts the same Slack behaviour on both stores.

type SlackConnectionRow = typeof slackConnections.$inferSelect

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

export class DrizzleSlackConnectionRepository implements SlackConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByAccount(accountId: string): Promise<SlackConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(slackConnections)
      .where(eq(slackConnections.account_id, accountId))
      .limit(1)
    return rows[0] ? rowToConnection(rows[0]) : null
  }

  async getByTeam(teamId: string): Promise<SlackConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(slackConnections)
      .where(and(eq(slackConnections.team_id, teamId), isNull(slackConnections.deleted_at)))
      .limit(1)
    return rows[0] ? rowToConnection(rows[0]) : null
  }

  async upsert(record: SlackConnectionRecord): Promise<void> {
    const values = {
      account_id: record.accountId,
      team_id: record.teamId,
      team_name: record.teamName,
      team_icon_url: record.teamIconUrl,
      bot_user_id: record.botUserId,
      scopes: record.scopesJson,
      token_cipher: record.tokenCipher,
      created_at: record.createdAt,
      deleted_at: null,
    }
    await this.db
      .insert(slackConnections)
      .values(values)
      .onConflictDoUpdate({
        target: [slackConnections.account_id],
        set: {
          team_id: values.team_id,
          team_name: values.team_name,
          team_icon_url: values.team_icon_url,
          bot_user_id: values.bot_user_id,
          scopes: values.scopes,
          token_cipher: values.token_cipher,
          created_at: values.created_at,
          deleted_at: null,
        },
      })
  }

  async softDelete(accountId: string, at: number): Promise<void> {
    await this.db
      .update(slackConnections)
      .set({ deleted_at: at })
      .where(and(eq(slackConnections.account_id, accountId), isNull(slackConnections.deleted_at)))
  }
}

type SlackSettingsRow = typeof slackSettings.$inferSelect

export class DrizzleSlackSettingsRepository implements SlackSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByWorkspace(workspaceId: string): Promise<SlackSettingsRecord | null> {
    const rows = await this.db
      .select()
      .from(slackSettings)
      .where(eq(slackSettings.workspace_id, workspaceId))
      .limit(1)
    const row: SlackSettingsRow | undefined = rows[0]
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      routesJson: row.routes,
      mentionsEnabled: row.mentions_enabled === 1,
      updatedAt: row.updated_at,
    }
  }

  async upsert(record: SlackSettingsRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      routes: record.routesJson,
      mentions_enabled: record.mentionsEnabled ? 1 : 0,
      updated_at: record.updatedAt,
    }
    await this.db
      .insert(slackSettings)
      .values(values)
      .onConflictDoUpdate({
        target: [slackSettings.workspace_id],
        set: {
          routes: values.routes,
          mentions_enabled: values.mentions_enabled,
          updated_at: values.updated_at,
        },
      })
  }
}

export class DrizzleSlackMemberMappingRepository implements SlackMemberMappingRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByAccount(accountId: string): Promise<SlackMemberMappingEntry[]> {
    const rows = await this.db
      .select()
      .from(slackMemberMappings)
      .where(eq(slackMemberMappings.account_id, accountId))
      .limit(1)
    if (!rows[0]) return []
    try {
      const parsed = JSON.parse(rows[0].entries)
      return Array.isArray(parsed) ? (parsed as SlackMemberMappingEntry[]) : []
    } catch {
      return []
    }
  }

  async upsert(accountId: string, entries: SlackMemberMappingEntry[], at: number): Promise<void> {
    const values = {
      account_id: accountId,
      entries: JSON.stringify(entries),
      updated_at: at,
    }
    await this.db
      .insert(slackMemberMappings)
      .values(values)
      .onConflictDoUpdate({
        target: [slackMemberMappings.account_id],
        set: { entries: values.entries, updated_at: values.updated_at },
      })
  }
}
