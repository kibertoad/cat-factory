import type { MergeThresholdPreset } from '../domain/types.js'

// Persistence port for per-workspace merge threshold presets. The worker
// implements it against D1; tests supply an in-memory fake. Exactly one preset
// per workspace is the default (`isDefault`), resolved for any task that hasn't
// picked one. Enforcing the single-default invariant is the repository's job
// (promoting a new default demotes the previous one).

export interface MergePresetRepository {
  /** A preset by id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<MergeThresholdPreset | null>
  /** All presets for a workspace (for the snapshot + settings UI). */
  list(workspaceId: string): Promise<MergeThresholdPreset[]>
  /** The workspace's default preset, or null if none is seeded yet. */
  getDefault(workspaceId: string): Promise<MergeThresholdPreset | null>
  /** Create or replace a preset (keyed by id). Promoting `isDefault` demotes the prior default. */
  upsert(workspaceId: string, preset: MergeThresholdPreset): Promise<void>
  /** Remove a preset by id (no-op if absent). The default preset cannot be removed. */
  remove(workspaceId: string, id: string): Promise<void>
}
