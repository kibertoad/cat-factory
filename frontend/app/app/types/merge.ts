// Merge-policy shapes, mirroring `@cat-factory/contracts` (merge.ts). A `merger`
// agent scores a PR on three 0..1 axes and the engine compares them against the
// task's resolved threshold preset to auto-merge or raise a review notification.

/** A `merger` agent's assessment of a pull request (each axis 0..1). */
export interface MergeAssessment {
  complexity: number
  risk: number
  impact: number
  rationale: string
}

/**
 * The highest reviewer-finding severity a task tolerates before the requirements review
 * stops for a human. `none` tolerates nothing; `high` tolerates everything. Ordered
 * none < low < medium < high.
 */
export type RequirementConcernLevel = 'none' | 'low' | 'medium' | 'high'

/** A named, per-workspace merge policy a task can select. */
export interface MergeThresholdPreset {
  id: string
  name: string
  /** Auto-merge only when the assessment's complexity is ≤ this. */
  maxComplexity: number
  /** Auto-merge only when the assessment's risk is ≤ this. */
  maxRisk: number
  /** Auto-merge only when the assessment's impact is ≤ this. */
  maxImpact: number
  /** How many times the CI-fixer may try before the CI gate gives up. */
  ciMaxAttempts: number
  /** How many reviewer passes the requirements-review loop runs before asking the human. */
  maxRequirementIterations: number
  /** Findings at or below this severity auto-pass without stopping for a human. */
  maxRequirementConcernAllowed: RequirementConcernLevel
  /** Minutes the post-release-health gate watches the release's monitors/SLOs after deploy. */
  releaseWatchWindowMinutes: number
  /** How many on-call investigations the post-release-health gate may dispatch. */
  releaseMaxAttempts: number
  /** The workspace's fallback preset, used by tasks that pick none. */
  isDefault: boolean
  createdAt: number
}

/** Create a merge threshold preset. */
export interface CreateMergePresetInput {
  name: string
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  ciMaxAttempts: number
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
  releaseWatchWindowMinutes?: number
  releaseMaxAttempts?: number
  isDefault?: boolean
}

/** Patch a merge threshold preset (all fields optional). */
export interface UpdateMergePresetInput {
  name?: string
  maxComplexity?: number
  maxRisk?: number
  maxImpact?: number
  ciMaxAttempts?: number
  maxRequirementIterations?: number
  maxRequirementConcernAllowed?: RequirementConcernLevel
  releaseWatchWindowMinutes?: number
  releaseMaxAttempts?: number
  isDefault?: boolean
}
