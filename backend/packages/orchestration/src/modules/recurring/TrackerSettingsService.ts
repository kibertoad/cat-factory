import { DEFAULT_TRACKER_WRITEBACK, type TrackerWritebackFlags } from '@cat-factory/contracts'
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

/**
 * The tracker settings returned before anything is set: nothing selected, and the writeback
 * disposition every reader shares (`DEFAULT_TRACKER_WRITEBACK`, which says why it is ON).
 */
const EMPTY: Omit<TrackerSettings, 'updatedAt'> = {
  tracker: null,
  jiraProjectKey: null,
  linearTeamId: null,
  ...DEFAULT_TRACKER_WRITEBACK,
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
      // Only keep a Linear team id when Linear is the selected tracker.
      linearTeamId: input.tracker === 'linear' ? input.linearTeamId?.trim() || null : null,
      // Writeback applies to a task's linked tracker issue(s) of any source, so it is
      // kept regardless of the filing tracker selection above. An omitted flag resets to the
      // deployment default rather than keeping the stored value: this is a wholesale PUT, which
      // `patchWriteback` below is the merging counterpart to.
      writebackCommentOnPrOpen:
        input.writebackCommentOnPrOpen ?? DEFAULT_TRACKER_WRITEBACK.writebackCommentOnPrOpen,
      writebackResolveOnMerge:
        input.writebackResolveOnMerge ?? DEFAULT_TRACKER_WRITEBACK.writebackResolveOnMerge,
      // The headless clarification loop's question echo (see the contract): only consulted for
      // runs started through the public API, so it is safe to keep alongside the PR toggles.
      writebackQuestionsOnPark:
        input.writebackQuestionsOnPark ?? DEFAULT_TRACKER_WRITEBACK.writebackQuestionsOnPark,
      updatedAt: this.clock.now(),
    }
    await this.repo.put(workspaceId, settings)
    return settings
  }

  /**
   * Change some writeback flags and leave everything else in the row exactly as it is.
   *
   * The `/api/v1` counterpart of {@link put}, and a different operation rather than a convenience
   * over it: that one REPLACES, so a caller enabling one flag through it would reset the filing
   * tracker selection to null and the other two flags to their defaults. A headless caller is
   * acting on one decision and cannot be expected to restate a row it never read.
   *
   * It reads through {@link get}, so an absent row patches on top of the DEFAULTS and the first
   * write is a complete row like any other.
   */
  async patchWriteback(
    workspaceId: string,
    patch: Partial<TrackerWritebackFlags>,
  ): Promise<TrackerSettings> {
    const current = await this.get(workspaceId)
    // An empty patch does not WRITE, because writing would be observable: it stamps `updatedAt`,
    // which is how a reader tells a disposition somebody chose from the defaults nobody has
    // touched. A no-op that quietly claims authorship of the defaults is the wrong no-op.
    if (Object.keys(patch).length === 0) return current
    const settings: TrackerSettings = {
      ...current,
      ...patch,
      updatedAt: this.clock.now(),
    }
    await this.repo.put(workspaceId, settings)
    return settings
  }
}
