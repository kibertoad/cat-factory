import type { TrackerSettings } from '../domain/types.js'

// Persistence port for a workspace's issue-tracker selection (one row per
// workspace). `get` returns null when nothing is configured yet; the tracker step
// then passes through.

/**
 * The fields ONE write names. An absent field is not written at all, so it keeps whatever the
 * stored row holds.
 *
 * That absence rule is the whole reason this type exists rather than the settings service handing
 * down a complete row. The row has two halves with different owners: the FILING selection (which
 * tracker a tech-debt ticket is raised on) is edited by one panel, and the three WRITEBACK actions
 * are edited by that panel, by `PATCH /api/v1/tracker/writeback`, and by nobody at all on a
 * workspace running the deployment defaults. A writer that has to restate the whole row to change
 * one field silently carries a stale value for every field it did not care about.
 */
export type TrackerSettingsPatch = Partial<Omit<TrackerSettings, 'updatedAt'>>

export interface TrackerSettingsRepository {
  get(workspaceId: string): Promise<TrackerSettings | null>
  /**
   * Write the fields `patch` names onto the workspace's row and answer the row as it now stands,
   * creating it from `defaults` (overlaid with the patch) when there is none.
   *
   * **The merge happens in the STORE, not in a read-modify-write above it.** Two writers naming
   * DIFFERENT fields both land, where a load-then-replace loses whichever committed first and
   * answers 200 to both. That race is reachable from one deployment in the ordinary way: the SPA's
   * settings panel and a headless `PATCH /api/v1/tracker/writeback` edit the same row, and the two
   * halves of it are precisely the fields the other writer does not name.
   */
  merge(
    workspaceId: string,
    patch: TrackerSettingsPatch,
    defaults: Omit<TrackerSettings, 'updatedAt'>,
    updatedAt: number,
  ): Promise<TrackerSettings>
}
