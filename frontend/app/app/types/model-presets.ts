// Model-preset shapes, mirroring `@cat-factory/contracts` (model-presets.ts). A preset
// is a named, per-workspace model->agent mapping: one base model applied to every
// agent kind plus per-kind overrides. A task selects one (Block.modelPresetId); none
// resolves to the workspace default preset.

/** A named, per-workspace model preset a task can select. */
export interface ModelPreset {
  id: string
  name: string
  /** The model every agent kind defaults to under this preset (a catalog id). */
  baseModelId: string
  /** Per-agent-kind model overrides on top of the base (agent kind → model id). */
  overrides: Record<string, string>
  /** The workspace's fallback preset, used by tasks that pick none. */
  isDefault: boolean
  createdAt: number
}

/** Create a model preset. */
export interface CreateModelPresetInput {
  name: string
  baseModelId: string
  overrides?: Record<string, string>
  isDefault?: boolean
}

/** Patch a model preset (all fields optional; `overrides` replaces the map). */
export interface UpdateModelPresetInput {
  name?: string
  baseModelId?: string
  overrides?: Record<string, string>
  isDefault?: boolean
}
