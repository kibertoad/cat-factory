// Model-preset shapes, mirroring `@cat-factory/contracts` (model-presets.ts). A preset
// is a named, per-workspace model->agent mapping: one base model applied to every
// agent kind plus per-kind overrides. A task selects one (Block.modelPresetId); none
// resolves to the workspace default preset.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  ModelPreset,
  CreateModelPresetInput,
  UpdateModelPresetInput,
} from '@cat-factory/contracts'
