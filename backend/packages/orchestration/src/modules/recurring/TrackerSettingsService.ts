import { DEFAULT_TRACKER_WRITEBACK, type TrackerWritebackFlags } from '@cat-factory/contracts'
import type {
  Clock,
  PutTrackerSettingsInput,
  TrackerSettings,
  TrackerSettingsPatch,
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

  /**
   * Replace the FILING selection, and move only the writeback actions the caller named.
   *
   * The filing half is wholesale: `tracker` is required, and its vendor target is cleared when the
   * selection moves off that vendor, because those three fields are one decision and a caller
   * editing it has just rendered all of it.
   *
   * The writeback half MERGES, which is the same rule {@link patchWriteback} follows. An omitted
   * action is not a request to move it, on either door. It used to reset to the deployment default
   * here, and that reading has no caller: the flags are booleans, so anyone who wants the defaults
   * can send them. What it did have was a victim, the recurring-pipeline modal, which persists a
   * tech-debt schedule's FILING tracker and names no writeback action at all. Under the reset rule
   * that call re-enabled every action a workspace had deliberately turned off, silently and from a
   * dialog about something else.
   */
  async put(workspaceId: string, input: PutTrackerSettingsInput): Promise<TrackerSettings> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return this.write(workspaceId, {
      tracker: input.tracker,
      // Only keep a Jira project key when Jira is the selected tracker.
      jiraProjectKey: input.tracker === 'jira' ? input.jiraProjectKey?.trim() || null : null,
      // Only keep a Linear team id when Linear is the selected tracker.
      linearTeamId: input.tracker === 'linear' ? input.linearTeamId?.trim() || null : null,
      // Writeback applies to a task's linked tracker issue(s) of any source, so these ride along
      // regardless of the filing selection above, and each is written only when named.
      ...pickWriteback(input),
    })
  }

  /**
   * Change some writeback actions and leave everything else in the row exactly as it is.
   *
   * The `/api/v1` counterpart of {@link put}, and a different operation rather than a convenience
   * over it: that one owns the filing selection, so a headless caller enabling one action through
   * it would have to restate which tracker the workspace files tech-debt tickets on, which is a
   * decision it never read and has no business in.
   */
  async patchWriteback(
    workspaceId: string,
    patch: Partial<TrackerWritebackFlags>,
  ): Promise<TrackerSettings> {
    // An empty patch does not WRITE, because writing would be observable: it stamps `updatedAt`,
    // which is how a reader tells a disposition somebody chose from the defaults nobody has
    // touched. A no-op that quietly claims authorship of the defaults is the wrong no-op.
    if (Object.keys(patch).length === 0) return this.get(workspaceId)
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return this.write(workspaceId, patch)
  }

  /**
   * The one write both doors go through: the named fields, merged onto the row in the STORE.
   *
   * Nothing is read first. A load-then-replace would let the SPA's panel and a headless patch race
   * on the two halves of this row and lose one of them, and it is the half the loser did not name
   * that would be silently rolled back to whatever it held when the winner loaded.
   */
  private write(workspaceId: string, patch: TrackerSettingsPatch): Promise<TrackerSettings> {
    return this.repo.merge(workspaceId, patch, EMPTY, this.clock.now())
  }
}

/** The writeback actions an input NAMED, with absence preserved rather than filled in. */
function pickWriteback(input: PutTrackerSettingsInput): Partial<TrackerWritebackFlags> {
  const patch: Partial<TrackerWritebackFlags> = {}
  if (input.writebackCommentOnPrOpen !== undefined) {
    patch.writebackCommentOnPrOpen = input.writebackCommentOnPrOpen
  }
  if (input.writebackResolveOnMerge !== undefined) {
    patch.writebackResolveOnMerge = input.writebackResolveOnMerge
  }
  // The headless clarification loop's question echo (see the contract): only consulted for runs
  // started through the public API, so it is safe to keep alongside the PR toggles.
  if (input.writebackQuestionsOnPark !== undefined) {
    patch.writebackQuestionsOnPark = input.writebackQuestionsOnPark
  }
  return patch
}
