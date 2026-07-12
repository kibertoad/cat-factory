import type {
  GroupCacheHandle,
  UpdateWorkspaceSettingsInput,
  WorkspaceRepository,
  WorkspaceSettings,
  WorkspaceSettingsCacheValue,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import {
  DEFAULT_WORKSPACE_SETTINGS,
  readCachedWorkspaceSettings,
  requireWorkspace,
} from '@cat-factory/kernel'

export interface WorkspaceSettingsServiceDependencies {
  workspaceSettingsRepository: WorkspaceSettingsRepository
  workspaceRepository: WorkspaceRepository
  /**
   * The shared {@link AppCaches.workspaceSettings} slice. When wired, {@link get} reads
   * through it and {@link update} invalidates the workspace's entry after the write commits
   * — the single write path for the row that `SpendService`/`LlmObservabilityService` also
   * read through the same slice, so a settings/budget edit is coherent everywhere at once.
   * Absent ⇒ reads go straight to the repository (tests).
   */
  workspaceSettingsCache?: GroupCacheHandle<WorkspaceSettingsCacheValue>
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
  private readonly cache?: GroupCacheHandle<WorkspaceSettingsCacheValue>

  constructor(deps: WorkspaceSettingsServiceDependencies) {
    this.settings = deps.workspaceSettingsRepository
    this.workspaceRepository = deps.workspaceRepository
    this.cache = deps.workspaceSettingsCache
  }

  /** A workspace's settings, falling back to the built-in defaults when none are stored. */
  async get(workspaceId: string): Promise<WorkspaceSettings> {
    return (
      (await readCachedWorkspaceSettings(this.cache, this.settings, workspaceId)) ?? {
        ...DEFAULT_WORKSPACE_SETTINGS,
      }
    )
  }

  /**
   * Resolve many workspaces' settings in one batched read, each falling back to the built-in
   * defaults when none are stored. A caller iterating every workspace (the notification
   * escalation sweep) uses this instead of a `get` per workspace to avoid an N+1 point-read.
   */
  async getMany(workspaceIds: string[]): Promise<Map<string, WorkspaceSettings>> {
    const stored = await this.settings.listByWorkspaceIds(workspaceIds)
    const out = new Map<string, WorkspaceSettings>()
    for (const id of workspaceIds) {
      out.set(id, stored.get(id) ?? { ...DEFAULT_WORKSPACE_SETTINGS })
    }
    return out
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
      artifactRetentionDays: patch.artifactRetentionDays ?? current.artifactRetentionDays,
      kaizenEnabled: patch.kaizenEnabled ?? current.kaizenEnabled,
      delegateAgentsToRunnerPool:
        patch.delegateAgentsToRunnerPool ?? current.delegateAgentsToRunnerPool,
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
    // Drop the cached row (and broadcast to peers) after the write commits, so the next
    // read on this or any replica — including SpendService's pricing overlay — sees the
    // new settings/budget immediately rather than after the TTL.
    await this.cache?.invalidate(workspaceId, workspaceId)
    return next
  }
}
