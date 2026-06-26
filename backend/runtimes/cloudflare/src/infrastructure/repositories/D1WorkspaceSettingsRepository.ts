import type { WorkspaceSettingsRepository } from '@cat-factory/kernel'
import type {
  SpendModelPrices,
  TaskLimitMode,
  TaskLimitPerType,
  WorkspaceSettings,
} from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface WorkspaceSettingsRow {
  waiting_escalation_minutes: number
  task_limit_mode: string
  task_limit_shared: number | null
  task_limit_per_type: string | null
  spend_currency: string | null
  spend_monthly_limit: number | null
  spend_model_prices: string | null
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function rowToSettings(row: WorkspaceSettingsRow): WorkspaceSettings {
  return {
    waitingEscalationMinutes: row.waiting_escalation_minutes,
    taskLimitMode: row.task_limit_mode as TaskLimitMode,
    taskLimitShared: row.task_limit_shared,
    taskLimitPerType: parseJson<TaskLimitPerType>(row.task_limit_per_type),
    spendCurrency: row.spend_currency,
    spendMonthlyLimit: row.spend_monthly_limit,
    spendModelPrices: parseJson<SpendModelPrices>(row.spend_model_prices),
  }
}

/**
 * Per-workspace runtime settings, one row per workspace in `workspace_settings`.
 * The service lazily seeds the default on first read, so an absent row reads as
 * `null` here. Per-type task limits are stored as a JSON column.
 */
export class D1WorkspaceSettingsRepository implements WorkspaceSettingsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<WorkspaceSettings | null> {
    const row = await this.db
      .prepare(`SELECT * FROM workspace_settings WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<WorkspaceSettingsRow>()
    return row ? rowToSettings(row) : null
  }

  async upsert(workspaceId: string, settings: WorkspaceSettings): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO workspace_settings
           (workspace_id, waiting_escalation_minutes, task_limit_mode, task_limit_shared,
            task_limit_per_type, spend_currency, spend_monthly_limit, spend_model_prices)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           waiting_escalation_minutes = excluded.waiting_escalation_minutes,
           task_limit_mode = excluded.task_limit_mode,
           task_limit_shared = excluded.task_limit_shared,
           task_limit_per_type = excluded.task_limit_per_type,
           spend_currency = excluded.spend_currency,
           spend_monthly_limit = excluded.spend_monthly_limit,
           spend_model_prices = excluded.spend_model_prices`,
      )
      .bind(
        workspaceId,
        settings.waitingEscalationMinutes,
        settings.taskLimitMode,
        settings.taskLimitShared,
        settings.taskLimitPerType ? JSON.stringify(settings.taskLimitPerType) : null,
        settings.spendCurrency,
        settings.spendMonthlyLimit,
        settings.spendModelPrices ? JSON.stringify(settings.spendModelPrices) : null,
      )
      .run()
  }
}
