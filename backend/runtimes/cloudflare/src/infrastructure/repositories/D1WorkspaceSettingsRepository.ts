import type { WorkspaceSettingsRepository } from '@cat-factory/kernel'
import type { TaskLimitMode, TaskLimitPerType, WorkspaceSettings } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface WorkspaceSettingsRow {
  waiting_escalation_minutes: number
  task_limit_mode: string
  task_limit_shared: number | null
  task_limit_per_type: string | null
  store_agent_context: number
}

function rowToSettings(row: WorkspaceSettingsRow): WorkspaceSettings {
  let perType: TaskLimitPerType | null = null
  if (row.task_limit_per_type) {
    try {
      perType = JSON.parse(row.task_limit_per_type) as TaskLimitPerType
    } catch {
      perType = null
    }
  }
  return {
    waitingEscalationMinutes: row.waiting_escalation_minutes,
    taskLimitMode: row.task_limit_mode as TaskLimitMode,
    taskLimitShared: row.task_limit_shared,
    taskLimitPerType: perType,
    storeAgentContext: row.store_agent_context === 1,
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
            task_limit_per_type, store_agent_context)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           waiting_escalation_minutes = excluded.waiting_escalation_minutes,
           task_limit_mode = excluded.task_limit_mode,
           task_limit_shared = excluded.task_limit_shared,
           task_limit_per_type = excluded.task_limit_per_type,
           store_agent_context = excluded.store_agent_context`,
      )
      .bind(
        workspaceId,
        settings.waitingEscalationMinutes,
        settings.taskLimitMode,
        settings.taskLimitShared,
        settings.taskLimitPerType ? JSON.stringify(settings.taskLimitPerType) : null,
        settings.storeAgentContext ? 1 : 0,
      )
      .run()
  }
}
