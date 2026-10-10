import type {
  Clock,
  UpdateWorkspaceAgentSettingsInput,
  WorkspaceAgentSettings,
  WorkspaceAgentSettingsRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'

export interface WorkspaceAgentSettingsServiceDependencies {
  workspaceAgentSettingsRepository: WorkspaceAgentSettingsRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

/**
 * Read/write a workspace's per-agent-kind generation settings — today the output-token ceiling
 * an agent kind's inline calls run under, edited from the pipeline builder beside the per-kind
 * system-prompt overrides.
 *
 * The store is sparse: a kind absent from it inherits the deployment routing ceiling. So
 * clearing the last configured field DELETES the row rather than leaving one whose every value
 * is null — otherwise "configured to inherit" and "never configured" would be two rows that
 * behave identically, and the settings UI would have to explain the difference.
 */
export class WorkspaceAgentSettingsService {
  private readonly settings: WorkspaceAgentSettingsRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly clock: Clock

  constructor(deps: WorkspaceAgentSettingsServiceDependencies) {
    this.settings = deps.workspaceAgentSettingsRepository
    this.workspaceRepository = deps.workspaceRepository
    this.clock = deps.clock
  }

  /** Every kind the workspace has configured. One query — never a read per pipeline step. */
  async list(workspaceId: string): Promise<WorkspaceAgentSettings[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return this.settings.list(workspaceId)
  }

  /**
   * Apply a partial update to one kind's settings and return the stored result, or `null` when
   * the update left nothing configured (the row is dropped and the kind inherits again).
   *
   * The input is a PATCH: an omitted field keeps its stored value, so a future second knob can be
   * written without a read-modify-write race against this one. An explicit `null` clears.
   */
  async update(
    workspaceId: string,
    agentKind: string,
    input: UpdateWorkspaceAgentSettingsInput,
  ): Promise<WorkspaceAgentSettings | null> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const current = await this.settings.get(workspaceId, agentKind)
    const maxOutputTokens =
      input.maxOutputTokens !== undefined
        ? input.maxOutputTokens
        : (current?.maxOutputTokens ?? null)

    // Nothing left configured ⇒ remove the row, so "inheriting" is expressed by ABSENCE only.
    if (maxOutputTokens === null) {
      if (current) await this.settings.remove(workspaceId, agentKind)
      return null
    }

    const next: WorkspaceAgentSettings = {
      agentKind,
      maxOutputTokens,
      updatedAt: this.clock.now(),
    }
    await this.settings.upsert(workspaceId, next)
    return next
  }
}
