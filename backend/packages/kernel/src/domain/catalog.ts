import type { BlockType, ModelPreset, RequirementConcernLevel, WorkspaceSettings } from './types.js'

// Static catalogs and constants used across the domain.

/**
 * The runtime settings every workspace starts with (lazily seeded on first read).
 * `waitingEscalationMinutes` is how long a run may wait for human input before its
 * notification turns red (runs are never auto-failed for waiting); the task limit is
 * off by default so existing boards keep their unbounded concurrency.
 */
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  waitingEscalationMinutes: 120,
  taskLimitMode: 'off',
  taskLimitShared: null,
  taskLimitPerType: null,
  storeAgentContext: true,
  artifactRetentionDays: 14,
  kaizenEnabled: true,
  delegateAgentsToRunnerPool: false,
  spendCurrency: null,
  spendMonthlyLimit: null,
}

/**
 * The built-in merge threshold preset seeded for every workspace, used by any
 * task that hasn't picked its own. A PR auto-merges only when the `merger`
 * agent's complexity/risk/impact all stay at or below these ceilings; otherwise a
 * `merge_review` notification is raised. `ciMaxAttempts` bounds how many times the
 * `ci-fixer` agent retries before the CI gate gives up.
 */
export const DEFAULT_MERGE_PRESET = {
  name: 'Balanced',
  maxComplexity: 0.5,
  maxRisk: 0.4,
  maxImpact: 0.5,
  ciMaxAttempts: 10,
  maxRequirementIterations: 6,
  // Tolerate nothing by default: any reviewer finding pauses the run for a human.
  maxRequirementConcernAllowed: 'none',
  // Post-release-health gate: how long (minutes) the gate watches the deployed
  // release's monitors/SLOs before declaring it healthy, and how many on-call
  // investigations may be dispatched while watching (the on-call agent investigates
  // rather than fixing prod, so 1 pass is the sensible default).
  releaseWatchWindowMinutes: 30,
  releaseMaxAttempts: 1,
  // Human-review gate: how long (minutes) the gate waits after the latest review comment
  // before dispatching the `fixer` to address the batch — a grace window so a reviewer
  // leaving a series of comments isn't churned mid-stream. Only applies to the unapproved
  // path (an approved PR's comments are addressed immediately).
  humanReviewGraceMinutes: 10,
  // Auto-merge is allowed: a within-threshold, credibly-explained assessment merges the PR.
  autoMergeEnabled: true,
} as const

/**
 * A built-in merge-preset template (no `createdAt` yet, but with a STABLE id so a
 * workspace's persisted copy can be matched against the catalog and reseeded). The
 * service stamps each with `createdAt` on first seed; {@link seedMergePresets} lists
 * the built-ins. Mirrors {@link ModelPresetSeed} / the pipeline seed shape, including
 * the monotonic `version` that drives the "reseed available" advisory.
 */
export interface MergePresetSeed {
  /** Stable catalog id (e.g. `mp_balanced`), used to match a stored copy for reseeding. */
  id: string
  name: string
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  ciMaxAttempts: number
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
  releaseWatchWindowMinutes: number
  releaseMaxAttempts: number
  humanReviewGraceMinutes: number
  /** When false, the `merger` step never auto-merges — every PR is routed to human review. */
  autoMergeEnabled: boolean
  /** The workspace's fallback preset, used by tasks that pick none. Exactly one is true. */
  isDefault: boolean
  /**
   * Monotonic seed version. When the current catalog version for this id exceeds a
   * workspace's persisted copy, the SPA offers to reseed it. Bump this when a built-in's
   * definition changes upstream so existing workspaces are advised to adopt the update.
   */
  version: number
}

/**
 * The built-in merge threshold presets seeded for every workspace. `Balanced` is the
 * default auto-merge policy; `Manual review only` disables auto-merge entirely
 * (`autoMergeEnabled: false`), so every PR on a task using it is routed to a human
 * `merge_review` notification regardless of the assessment. A workspace keeps at least
 * these until the operator edits the library. To ship a new built-in (or a new version
 * of one), add it here / bump its `version`; existing workspaces are then advised to
 * reseed (new presets appear, changed ones flag an update).
 */
export const MERGE_PRESET_SEEDS: MergePresetSeed[] = [
  {
    id: 'mp_balanced',
    name: DEFAULT_MERGE_PRESET.name,
    maxComplexity: DEFAULT_MERGE_PRESET.maxComplexity,
    maxRisk: DEFAULT_MERGE_PRESET.maxRisk,
    maxImpact: DEFAULT_MERGE_PRESET.maxImpact,
    ciMaxAttempts: DEFAULT_MERGE_PRESET.ciMaxAttempts,
    maxRequirementIterations: DEFAULT_MERGE_PRESET.maxRequirementIterations,
    maxRequirementConcernAllowed: DEFAULT_MERGE_PRESET.maxRequirementConcernAllowed,
    releaseWatchWindowMinutes: DEFAULT_MERGE_PRESET.releaseWatchWindowMinutes,
    releaseMaxAttempts: DEFAULT_MERGE_PRESET.releaseMaxAttempts,
    humanReviewGraceMinutes: DEFAULT_MERGE_PRESET.humanReviewGraceMinutes,
    autoMergeEnabled: DEFAULT_MERGE_PRESET.autoMergeEnabled,
    isDefault: true,
    version: 1,
  },
  {
    id: 'mp_manual_review',
    name: 'Manual review only',
    // Thresholds are irrelevant while auto-merge is off, but keep them valid + conservative.
    maxComplexity: 0,
    maxRisk: 0,
    maxImpact: 0,
    ciMaxAttempts: DEFAULT_MERGE_PRESET.ciMaxAttempts,
    maxRequirementIterations: DEFAULT_MERGE_PRESET.maxRequirementIterations,
    maxRequirementConcernAllowed: 'none',
    releaseWatchWindowMinutes: DEFAULT_MERGE_PRESET.releaseWatchWindowMinutes,
    releaseMaxAttempts: DEFAULT_MERGE_PRESET.releaseMaxAttempts,
    humanReviewGraceMinutes: DEFAULT_MERGE_PRESET.humanReviewGraceMinutes,
    // The whole point of this preset: never auto-merge — always raise a human review.
    autoMergeEnabled: false,
    isDefault: false,
    version: 1,
  },
]

/** The built-in merge presets, fresh copies so callers can stamp ids/timestamps safely. */
export function seedMergePresets(): MergePresetSeed[] {
  return MERGE_PRESET_SEEDS.map((p) => ({ ...p }))
}

/** Fallback CI-fixer attempt budget when no preset resolves (defensive default). */
export const DEFAULT_CI_MAX_ATTEMPTS = DEFAULT_MERGE_PRESET.ciMaxAttempts

/**
 * Fallback cap on the iterative requirements-review loop (reviewer passes) when no
 * preset resolves. One reviewer pass = one iteration; the initial review is iteration 1.
 */
export const DEFAULT_MAX_REQUIREMENT_ITERATIONS = DEFAULT_MERGE_PRESET.maxRequirementIterations

/**
 * Budgets for the linked-context the engine assembles for an agent step. Container
 * kinds get a cheap in-prompt summary index (capped by `maxItems`/`summaryChars`)
 * plus the full bodies materialised as files in the run workspace (capped overall by
 * `maxContextFileBytes` so the job body can't bloat). Inline kinds — which have no
 * checkout to explore — instead get the full body injected into the prompt, trimmed
 * to `inlineBodyTokens` (see {@link estimateTokens}). Tunable; deliberately generous
 * on the file budget (the agent only reads what it needs) and tight on the prompt.
 */
export const CONTEXT_BUDGET = {
  /** Max linked items listed in the in-prompt summary index. */
  maxItems: 20,
  /** Length of each item's one-line summary in the index. */
  summaryChars: 160,
  /** Token budget for body injected into an inline (no-checkout) kind's prompt. */
  inlineBodyTokens: 2500,
  /** Total bytes cap across all materialised context files in a job body (~256 KB). */
  maxContextFileBytes: 262_144,
} as const

/**
 * A model preset template (no id/createdAt yet) used to seed a fresh workspace's
 * preset library. {@link DEFAULT_MODEL_PRESETS} lists the built-ins; the service
 * stamps each with an id + createdAt on first use.
 */
export interface ModelPresetSeed {
  name: string
  baseModelId: string
  overrides: Record<string, string>
  isDefault: boolean
}

/**
 * The model presets seeded for every workspace. The default points every agent kind
 * at Kimi K2.7; a second built-in points everything at GLM-5.2. Both use the catalog
 * ids from {@link MODEL_CATALOG} (`kimi-k2.7`, `glm`). A workspace always keeps at
 * least these until the operator edits the library.
 */
export const DEFAULT_MODEL_PRESETS: ModelPresetSeed[] = [
  { name: 'Kimi K2.7', baseModelId: 'kimi-k2.7', overrides: {}, isDefault: true },
  { name: 'GLM-5.2', baseModelId: 'glm', overrides: {}, isDefault: false },
]

/** The built-in default preset (everything Kimi K2.7), used as the resolution fallback. */
export const DEFAULT_MODEL_PRESET: ModelPresetSeed =
  DEFAULT_MODEL_PRESETS.find((p) => p.isDefault) ?? DEFAULT_MODEL_PRESETS[0]!

/**
 * The model id a preset assigns to an agent kind: its per-kind override, else the
 * preset's base model. When no preset is resolved (a workspace not yet seeded), falls
 * back to the built-in {@link DEFAULT_MODEL_PRESET} (everything Kimi K2.7) — so the
 * "everything Kimi" default holds even before the preset library is materialised.
 */
export function modelForKindFromPreset(
  preset: ModelPreset | ModelPresetSeed | null | undefined,
  agentKind: string,
): string {
  const p = preset ?? DEFAULT_MODEL_PRESET
  return p.overrides[agentKind] ?? p.baseModelId
}

/** Human-facing label per block type, used when titling freshly dropped frames. */
export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  frontend: 'Frontend',
  service: 'Service',
  api: 'API',
  database: 'Database',
  queue: 'Queue',
  integration: 'Integration',
  external: 'External',
  environment: 'Environment',
}
