import type {
  Clock,
  PutTrackerSettingsInput,
  TrackerSettings,
  TrackerSettingsRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'

export interface TrackerSettingsServiceDependencies {
  trackerSettingsRepository: TrackerSettingsRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

/** The empty/unconfigured tracker settings returned before anything is set. */
const EMPTY: Omit<TrackerSettings, 'updatedAt'> = {
  tracker: null,
  jiraProjectKey: null,
  writebackCommentOnPrOpen: false,
  writebackResolveOnMerge: false,
}

/** Read/write a workspace's issue-tracker selection (one row per workspace). */
export class TrackerSettingsService {
  private readonly repo: TrackerSettingsRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly clock: Clock

  constructor(deps: TrackerSettingsServiceDependencies) {
    this.repo = deps.trackerSettingsRepository
    this.workspaceRepository = deps.workspaceRepository
    this.clock = deps.clock
  }

  async get(workspaceId: string): Promise<TrackerSettings> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return (await this.repo.get(workspaceId)) ?? { ...EMPTY, updatedAt: 0 }
  }

  async put(workspaceId: string, input: PutTrackerSettingsInput): Promise<TrackerSettings> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const settings: TrackerSettings = {
      tracker: input.tracker,
      // Only keep a Jira project key when Jira is the selected tracker.
      jiraProjectKey: input.tracker === 'jira' ? input.jiraProjectKey?.trim() || null : null,
      // Writeback applies to a task's linked tracker issue(s) of any source, so it is
      // kept regardless of the filing tracker selection above. Default off.
      writebackCommentOnPrOpen: input.writebackCommentOnPrOpen ?? false,
      writebackResolveOnMerge: input.writebackResolveOnMerge ?? false,
      updatedAt: this.clock.now(),
    }
    await this.repo.put(workspaceId, settings)
    return settings
  }
}
