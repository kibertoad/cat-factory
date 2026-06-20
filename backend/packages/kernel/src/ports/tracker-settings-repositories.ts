import type { TrackerSettings } from '../domain/types.js'

// Persistence port for a workspace's issue-tracker selection (one row per
// workspace). `get` returns null when nothing is configured yet; the tracker step
// then passes through.

export interface TrackerSettingsRepository {
  get(workspaceId: string): Promise<TrackerSettings | null>
  put(workspaceId: string, settings: TrackerSettings): Promise<void>
}
