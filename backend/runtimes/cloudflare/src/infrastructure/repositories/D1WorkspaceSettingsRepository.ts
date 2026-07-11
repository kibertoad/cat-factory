import type { WorkspaceSettingsRepository } from '@cat-factory/kernel'
import type { TaskLimitMode, TaskLimitPerType, WorkspaceSettings } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface WorkspaceSettingsRow {
  workspace_id: string
  waiting_escalation_minutes: number
  task_limit_mode: string
  task_limit_shared: number | null
  task_limit_per_type: string | null
  store_agent_context: number
  artifact_retention_days: number
  kaizen_enabled: number
  delegate_agents_to_runner_pool: number
  spend_currency: string | null
  spend_monthly_limit: number | null
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
    storeAgentContext: row.store_agent_context === 1,
    artifactRetentionDays: row.artifact_retention_days,
    kaizenEnabled: row.kaizen_enabled === 1,
    delegateAgentsToRunnerPool: row.delegate_agents_to_runner_pool === 1,
    spendCurrency: row.spend_currency,
    spendMonthlyLimit: row.spend_monthly_limit,
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

  async listByWorkspaceIds(workspaceIds: string[]): Promise<Map<string, WorkspaceSettings>> {
    const out = new Map<string, WorkspaceSettings>()
    if (workspaceIds.length === 0) return out
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(workspaceIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(`SELECT * FROM workspace_settings WHERE workspace_id IN (${placeholders})`)
        .bind(...chunk)
        .all<WorkspaceSettingsRow>()
      for (const row of results ?? []) out.set(row.workspace_id, rowToSettings(row))
    }
    return out
  }

  async upsert(workspaceId: string, settings: WorkspaceSettings): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO workspace_settings
           (workspace_id, waiting_escalation_minutes, task_limit_mode, task_limit_shared,
            task_limit_per_type, store_agent_context, artifact_retention_days, kaizen_enabled,
            delegate_agents_to_runner_pool, spend_currency,
            spend_monthly_limit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           waiting_escalation_minutes = excluded.waiting_escalation_minutes,
           task_limit_mode = excluded.task_limit_mode,
           task_limit_shared = excluded.task_limit_shared,
           task_limit_per_type = excluded.task_limit_per_type,
           store_agent_context = excluded.store_agent_context,
           artifact_retention_days = excluded.artifact_retention_days,
           kaizen_enabled = excluded.kaizen_enabled,
           delegate_agents_to_runner_pool = excluded.delegate_agents_to_runner_pool,
           spend_currency = excluded.spend_currency,
           spend_monthly_limit = excluded.spend_monthly_limit`,
      )
      .bind(
        workspaceId,
        settings.waitingEscalationMinutes,
        settings.taskLimitMode,
        settings.taskLimitShared,
        settings.taskLimitPerType ? JSON.stringify(settings.taskLimitPerType) : null,
        settings.storeAgentContext ? 1 : 0,
        settings.artifactRetentionDays,
        settings.kaizenEnabled ? 1 : 0,
        settings.delegateAgentsToRunnerPool ? 1 : 0,
        settings.spendCurrency,
        settings.spendMonthlyLimit,
      )
      .run()
  }
}
