import type { ModelPreset } from '../domain/types.js'

// Persistence port for per-workspace model presets. The worker implements it
// against D1, the Node service against Postgres; tests supply an in-memory fake.
// A preset is one `baseModelId` applied to every agent kind plus per-kind
// `overrides`; exactly one preset per workspace is the default (`isDefault`),
// resolved for any task that hasn't picked one. Enforcing the single-default
// invariant is the repository's job (promoting a new default demotes the prior one).

export interface ModelPresetRepository {
  /** A preset by id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<ModelPreset | null>
  /** All presets for a workspace (for the snapshot + settings UI). */
  list(workspaceId: string): Promise<ModelPreset[]>
  /** The workspace's default preset, or null if none is seeded yet. */
  getDefault(workspaceId: string): Promise<ModelPreset | null>
  /** Create or replace a preset (keyed by id). Promoting `isDefault` demotes the prior default. */
  upsert(workspaceId: string, preset: ModelPreset): Promise<void>
  /** Remove a preset by id (no-op if absent). The default preset cannot be removed. */
  remove(workspaceId: string, id: string): Promise<void>
}
