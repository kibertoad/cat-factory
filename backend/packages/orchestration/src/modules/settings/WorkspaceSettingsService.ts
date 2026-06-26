import type {
  UpdateWorkspaceSettingsInput,
  WorkspaceRepository,
  WorkspaceSettings,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS, requireWorkspace } from '@cat-factory/kernel'

export interface WorkspaceSettingsServiceDependencies {
  workspaceSettingsRepository: WorkspaceSettingsRepository
  workspaceRepository: WorkspaceRepository
}

/**
 * Get/update a workspace's runtime settings (the human-wait escalation threshold +
 * the per-service running-task limit policy). {@link get} lazily falls back to
 * {@link DEFAULT_WORKSPACE_SETTINGS} when no row has been persisted yet, so callers
 * always see a complete settings object. {@link update} patches the supplied fields
 * and keeps the limit fields internally consistent with the chosen mode.
 */
export class WorkspaceSettingsService {
  private readonly settings: WorkspaceSettingsRepository
  private readonly workspaceRepository: WorkspaceRepository

  constructor(deps: WorkspaceSettingsServiceDependencies) {
    this.settings = deps.workspaceSettingsRepository
    this.workspaceRepository = deps.workspaceRepository
  }

  /** A workspace's settings, falling back to the built-in defaults when none are stored. */
  async get(workspaceId: string): Promise<WorkspaceSettings> {
    return (await this.settings.get(workspaceId)) ?? { ...DEFAULT_WORKSPACE_SETTINGS }
  }

  /** Patch a workspace's settings, persisting the merged result. */
  async update(
    workspaceId: string,
    patch: UpdateWorkspaceSettingsInput,
  ): Promise<WorkspaceSettings> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const current = await this.get(workspaceId)
    const next: WorkspaceSettings = {
      waitingEscalationMinutes: patch.waitingEscalationMinutes ?? current.waitingEscalationMinutes,
      taskLimitMode: patch.taskLimitMode ?? current.taskLimitMode,
      taskLimitShared:
        patch.taskLimitShared !== undefined ? patch.taskLimitShared : current.taskLimitShared,
      taskLimitPerType:
        patch.taskLimitPerType !== undefined ? patch.taskLimitPerType : current.taskLimitPerType,
      storeAgentContext: patch.storeAgentContext ?? current.storeAgentContext,
      kaizenEnabled: patch.kaizenEnabled ?? current.kaizenEnabled,
      spendCurrency:
        patch.spendCurrency !== undefined ? patch.spendCurrency : current.spendCurrency,
      spendMonthlyLimit:
        patch.spendMonthlyLimit !== undefined ? patch.spendMonthlyLimit : current.spendMonthlyLimit,
    }
    // Keep the limit fields consistent with the mode so the enforcement logic + UI never
    // read a stale cap from an inactive mode.
    if (next.taskLimitMode === 'off') {
      next.taskLimitShared = null
      next.taskLimitPerType = null
    } else if (next.taskLimitMode === 'shared') {
      next.taskLimitPerType = null
      if (next.taskLimitShared == null) next.taskLimitShared = 1
    } else {
      next.taskLimitShared = null
      if (next.taskLimitPerType == null) next.taskLimitPerType = {}
    }
    await this.settings.upsert(workspaceId, next)
    return next
  }
}
