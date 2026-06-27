// Merge-policy shapes, mirroring `@cat-factory/contracts` (merge.ts). A `merger`
// agent scores a PR on three 0..1 axes and the engine compares them against the
// task's resolved threshold preset to auto-merge or raise a review notification.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  MergeAssessment,
  RequirementConcernLevel,
  MergeThresholdPreset,
  CreateMergePresetInput,
  UpdateMergePresetInput,
} from '@cat-factory/contracts'
