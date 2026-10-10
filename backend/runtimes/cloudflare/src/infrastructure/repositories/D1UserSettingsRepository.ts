import type { UserSettings } from '@cat-factory/contracts'
import type { UserSettingsRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface UserSettingsRow {
  user_id: string
  spend_monthly_limit: number | null
  updated_at: number
}

function rowToSettings(row: UserSettingsRow): UserSettings {
  return { spendMonthlyLimit: row.spend_monthly_limit }
}

/** D1-backed per-user settings (the user-tier budget; migration 0042). */
export class D1UserSettingsRepository implements UserSettingsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(userId: string): Promise<UserSettings | null> {
    const row = await this.db
      .prepare('SELECT * FROM user_settings WHERE user_id = ?')
      .bind(userId)
      .first<UserSettingsRow>()
    return row ? rowToSettings(row) : null
  }

  async upsert(userId: string, settings: UserSettings): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_settings (user_id, spend_monthly_limit, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           spend_monthly_limit = excluded.spend_monthly_limit,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, settings.spendMonthlyLimit ?? null, Date.now())
      .run()
  }
}
