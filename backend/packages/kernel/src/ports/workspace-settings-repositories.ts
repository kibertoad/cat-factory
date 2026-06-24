import type { WorkspaceSettings } from '../domain/types.js'

// Persistence port for per-workspace runtime settings (the human-wait escalation
// threshold + the per-service running-task limit policy). Exactly one settings row
// per workspace; the service lazily seeds it from DEFAULT_WORKSPACE_SETTINGS on first
// read. Each runtime facade implements it (D1 / Drizzle); tests supply an in-memory fake.

export interface WorkspaceSettingsRepository {
  /** A workspace's settings, or null if none have been persisted yet (caller seeds the default). */
  get(workspaceId: string): Promise<WorkspaceSettings | null>
  /** Create or replace a workspace's settings. */
  upsert(workspaceId: string, settings: WorkspaceSettings): Promise<void>
}
