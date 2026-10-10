// Merge-policy shapes, mirroring `@cat-factory/contracts` (merge.ts). A `merger`
// agent scores a PR on three 0..1 axes and the engine compares them against the
// task's resolved threshold preset to auto-merge or raise a review notification.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  MergeAssessment,
  // Merge track record — the per-class human evidence behind the auto-merge policy.
  ChangeClass,
  MergeClassRollup,
  MergeClassRule,
  MergeClassRules,
  RuleableChangeClass,
  // The ROLE layer of a preset: per-role narrowing of the rules above, and the roles whose
  // runs are sandboxed (they open a pull request and merge nothing).
  ClassRulesByRole,
  DryRunRoles,
  // Which change classes a role may LAND at all (absent ⇒ unrestricted, empty ⇒ nothing).
  SubmissionClassesByRole,
  WorkspaceRole,
  MergeTrackRecord,
  ReviewEffort,
  RequirementConcernLevel,
  RiskPolicy,
  CreateRiskPolicyInput,
  UpdateRiskPolicyInput,
  // The two tiers a policy can be stored at, the merged library entry a board picks from, and one
  // account policy a board is hiding (ADR 0055).
  RiskPolicyTier,
  RiskPolicyLibraryEntry,
  RiskPolicySuppression,
} from '@cat-factory/contracts'
