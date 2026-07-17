// ---------------------------------------------------------------------------
// Repo-sourced Claude Skills library (docs/initiatives/repo-skills.md). Mirrors
// the `@cat-factory/contracts` skill-library schemas: the account skill catalog
// (shared across the account's workspaces), the repo sources that feed it, and the
// lightweight per-skill summary carried in the workspace snapshot for the picker.
// ---------------------------------------------------------------------------
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  SkillResource,
  AccountSkill,
  SkillSource,
  SkillSummary,
  LinkSkillSourceInput,
  SkillSyncResult,
  SkillSourceStatus,
} from '@cat-factory/contracts'
