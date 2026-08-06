import { DEFAULT_JUDGE_MAX_BOUNCES, DEFAULT_JUDGE_MIN_SCORE } from '@cat-factory/contracts'
import type {
  BlockType,
  ClassRulesByRole,
  MergeClassRules,
  ModelPreset,
  RequirementConcernLevel,
  StepGating,
  SubmissionClassesByRole,
  WorkspaceRole,
  WorkspaceSettings,
} from './types.js'

/**
 * The implementation-fork decision gate as seeded on the built-in presets: DISABLED by
 * default (fork surfacing is off in `auto` mode until an operator turns it on), but with
 * sensible thresholds primed so flipping `enabled` on is a single toggle. `onMissingEstimate:
 * 'run'` means "propose even without an estimate" (fail toward asking).
 */
const DEFAULT_FORK_DECISION_GATING: StepGating = {
  enabled: false,
  minComplexity: 0.5,
  minRisk: 0.4,
  minImpact: 0.4,
  onMissingEstimate: 'run',
}

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
  publishPrVerificationReport: true,
  artifactRetentionDays: 14,
  // The Done swimlane keeps two weeks and 20 cards. Both are visibility caps, not deletion:
  // a service that has merged 400 tasks still says so in the lane's total, and everything
  // aged out stays reachable from search and its own inspector.
  doneLaneMaxItems: 20,
  doneLaneRetentionDays: 14,
  kaizenEnabled: true,
  delegateAgentsToRunnerPool: false,
  // On, and deliberately not opt-in: every blocking finding names an input a model could not
  // act on either, so the gate can only ever save the call that would have reported the same
  // absence. A workspace that would rather watch before it parks moves this to `advisory`.
  inputGateMode: 'standard',
  reviewFrictionMode: 'off',
  reviewFrictionWarnCount: 3,
  reviewFrictionBlockCount: null,
  reviewFrictionBlockStuckMinutes: null,
  spendCurrency: null,
  spendMonthlyLimit: null,
  // Null, not `infraless`: a fresh board has NOT decided how its services get a test
  // environment, and the SPA's setup banner needs to tell that apart from a deliberate
  // "no environments" choice (which is `infraless`, and silences the banner).
  defaultProvisionType: null,
  defaultProvisionManifestId: null,
  // On: a run authenticates as its initiator when they stored a PAT, so pushes and PRs are
  // attributed to the human who started it. An operator who would rather bound every run to
  // the App installation's scope turns it off (see the field's contract doc).
  allowInitiatorPat: true,
  // Empty, not seeded: which metadata FIELDS exist is declared by the deployment's app,
  // and a value only ever arrives by someone typing it in.
  metadata: {},
}

/**
 * The built-in merge threshold preset seeded for every workspace, used by any
 * task that hasn't picked its own. A PR auto-merges only when the `merger`
 * agent's complexity/risk/impact all stay at or below these ceilings; otherwise a
 * `merge_review` notification is raised. `ciMaxAttempts` bounds how many times the
 * `ci-fixer` agent retries before the CI gate gives up.
 */
export const DEFAULT_RISK_POLICY = {
  name: 'Balanced',
  maxComplexity: 0.5,
  maxRisk: 0.4,
  maxImpact: 0.5,
  ciMaxAttempts: 10,
  maxRequirementIterations: 6,
  // Tolerate nothing by default: any reviewer finding pauses the run for a human.
  maxRequirementConcernAllowed: 'none',
  // Test quality-control companion: how many times it may loop the Tester for a more
  // complete report before letting the run proceed to the greenlight / fixer decision.
  maxTesterQualityIterations: 3,
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
  // Judge steps (the fourth taxonomy bucket): the minimum verdict score a rubric assessment
  // must reach to advance without a human, and how many rework BOUNCE rounds a judge may
  // spend before it must ask one. See `docs/initiatives/judge-registry.md`.
  judgeMinScore: DEFAULT_JUDGE_MIN_SCORE,
  judgeMaxBounces: DEFAULT_JUDGE_MAX_BOUNCES,
  // Auto-merge is allowed: a within-threshold, credibly-explained assessment merges the PR.
  autoMergeEnabled: true,
  // Implementation-fork decision gate: disabled by default (see DEFAULT_FORK_DECISION_GATING).
  forkDecision: DEFAULT_FORK_DECISION_GATING,
} as const

/**
 * The built-in presets ship with NO per-class rules: every class falls back to the score
 * ceilings, so the default policy is byte-for-byte the historical behaviour. Widening a class
 * to `always` is an operator decision the workspace makes once its per-class track record
 * justifies it — never something a seed decides on their behalf.
 */
export const DEFAULT_MERGE_CLASS_RULES: MergeClassRules = {}

/**
 * The built-in presets ship with NO role-scoped narrowing and NO sandboxed roles, for the same
 * reason they ship no per-class rules: who a deployment trusts with what is exactly the judgement
 * a seed cannot make on an operator's behalf, and the identity of these two empties is what keeps
 * every existing workspace on byte-for-byte its previous merge behaviour.
 */
export const DEFAULT_CLASS_RULES_BY_ROLE: ClassRulesByRole = {}
export const DEFAULT_DRY_RUN_ROLES: readonly WorkspaceRole[] = []

/**
 * Nor any per-role submission allowlist: every role may land every class until an operator says
 * otherwise. The identity here is an ABSENT entry per role rather than an empty list, which is
 * why this is `{}` and not a map of full lists: an explicit list would silently bar whatever
 * class the vocabulary gains next, and a seed may not make that call for a deployment.
 */
export const DEFAULT_SUBMISSION_CLASSES_BY_ROLE: SubmissionClassesByRole = {}

/**
 * A built-in merge-preset template (no `createdAt` yet, but with a STABLE id so a
 * workspace's persisted copy can be matched against the catalog and reseeded). The
 * service stamps each with `createdAt` on first seed; {@link seedRiskPolicies} lists
 * the built-ins. Mirrors {@link ModelPresetSeed} / the pipeline seed shape, including
 * the monotonic `version` that drives the "reseed available" advisory.
 */
export interface RiskPolicySeed {
  /** Stable catalog id (e.g. `mp_balanced`), used to match a stored copy for reseeding. */
  id: string
  name: string
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  ciMaxAttempts: number
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
  maxTesterQualityIterations: number
  releaseWatchWindowMinutes: number
  releaseMaxAttempts: number
  humanReviewGraceMinutes: number
  /** Minimum judge verdict score (0..1) required to advance without a human. */
  judgeMinScore: number
  /** How many judge BOUNCE rounds are allowed before the judge must ask a human. */
  judgeMaxBounces: number
  /** When false, the `merger` step never auto-merges — every PR is routed to human review. */
  autoMergeEnabled: boolean
  /** Estimate gating for the implementation-fork decision phase; disabled on the built-ins. */
  forkDecision: StepGating | null
  /** Per-change-class auto-merge rules; empty on the built-ins (see DEFAULT_MERGE_CLASS_RULES). */
  classRules: MergeClassRules
  /** Per-role narrowing of `classRules`; empty on the built-ins. */
  classRulesByRole: ClassRulesByRole
  /** Roles whose runs are forced into dry-run mode; empty on the built-ins. */
  dryRunRoles: WorkspaceRole[]
  /** Per-role allowlist of landable change classes; empty on the built-ins. */
  submissionClassesByRole: SubmissionClassesByRole
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
export const RISK_POLICY_SEEDS: RiskPolicySeed[] = [
  {
    id: 'mp_balanced',
    name: DEFAULT_RISK_POLICY.name,
    maxComplexity: DEFAULT_RISK_POLICY.maxComplexity,
    maxRisk: DEFAULT_RISK_POLICY.maxRisk,
    maxImpact: DEFAULT_RISK_POLICY.maxImpact,
    ciMaxAttempts: DEFAULT_RISK_POLICY.ciMaxAttempts,
    maxRequirementIterations: DEFAULT_RISK_POLICY.maxRequirementIterations,
    maxRequirementConcernAllowed: DEFAULT_RISK_POLICY.maxRequirementConcernAllowed,
    maxTesterQualityIterations: DEFAULT_RISK_POLICY.maxTesterQualityIterations,
    releaseWatchWindowMinutes: DEFAULT_RISK_POLICY.releaseWatchWindowMinutes,
    releaseMaxAttempts: DEFAULT_RISK_POLICY.releaseMaxAttempts,
    humanReviewGraceMinutes: DEFAULT_RISK_POLICY.humanReviewGraceMinutes,
    judgeMinScore: DEFAULT_RISK_POLICY.judgeMinScore,
    judgeMaxBounces: DEFAULT_RISK_POLICY.judgeMaxBounces,
    autoMergeEnabled: DEFAULT_RISK_POLICY.autoMergeEnabled,
    forkDecision: { ...DEFAULT_FORK_DECISION_GATING },
    classRules: { ...DEFAULT_MERGE_CLASS_RULES },
    classRulesByRole: { ...DEFAULT_CLASS_RULES_BY_ROLE },
    dryRunRoles: [...DEFAULT_DRY_RUN_ROLES],
    submissionClassesByRole: { ...DEFAULT_SUBMISSION_CLASSES_BY_ROLE },
    isDefault: true,
    version: 6,
  },
  {
    id: 'mp_manual_review',
    name: 'Manual review only',
    // Thresholds are irrelevant while auto-merge is off, but keep them valid + conservative.
    maxComplexity: 0,
    maxRisk: 0,
    maxImpact: 0,
    ciMaxAttempts: DEFAULT_RISK_POLICY.ciMaxAttempts,
    maxRequirementIterations: DEFAULT_RISK_POLICY.maxRequirementIterations,
    maxRequirementConcernAllowed: 'none',
    maxTesterQualityIterations: DEFAULT_RISK_POLICY.maxTesterQualityIterations,
    releaseWatchWindowMinutes: DEFAULT_RISK_POLICY.releaseWatchWindowMinutes,
    releaseMaxAttempts: DEFAULT_RISK_POLICY.releaseMaxAttempts,
    humanReviewGraceMinutes: DEFAULT_RISK_POLICY.humanReviewGraceMinutes,
    judgeMinScore: DEFAULT_RISK_POLICY.judgeMinScore,
    // A manual-review preset never spends rework rounds on its own: a failing rubric verdict
    // goes straight to the human it already routes everything to.
    judgeMaxBounces: 0,
    // The whole point of this preset: never auto-merge — always raise a human review.
    autoMergeEnabled: false,
    forkDecision: { ...DEFAULT_FORK_DECISION_GATING },
    // No per-class rules: a class rule can never override `autoMergeEnabled: false`, and
    // shipping one here would only mislead an operator reading the preset.
    classRules: { ...DEFAULT_MERGE_CLASS_RULES },
    // Nor any role-scoped narrowing: narrowing is subtractive, and there is nothing left to
    // subtract from a preset that already routes every PR to a human.
    classRulesByRole: { ...DEFAULT_CLASS_RULES_BY_ROLE },
    dryRunRoles: [...DEFAULT_DRY_RUN_ROLES],
    // Nor an allowlist. This preset already routes every PR to a human, but the allowlist is the
    // one role setting that would still bite here (it refuses the MANUAL merge too), and seeding
    // one would be this catalog deciding which tier a deployment trusts with what.
    submissionClassesByRole: { ...DEFAULT_SUBMISSION_CLASSES_BY_ROLE },
    isDefault: false,
    version: 6,
  },
]

/** The built-in merge presets, fresh copies so callers can stamp ids/timestamps safely. */
export function seedRiskPolicies(): RiskPolicySeed[] {
  return RISK_POLICY_SEEDS.map((p) => ({ ...p }))
}

/** Fallback CI-fixer attempt budget when no preset resolves (defensive default). */
export const DEFAULT_CI_MAX_ATTEMPTS = DEFAULT_RISK_POLICY.ciMaxAttempts

/**
 * Fallback cap on the iterative requirements-review loop (reviewer passes) when no
 * preset resolves. One reviewer pass = one iteration; the initial review is iteration 1.
 */
export const DEFAULT_MAX_REQUIREMENT_ITERATIONS = DEFAULT_RISK_POLICY.maxRequirementIterations

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
 * A built-in model-preset template (no `createdAt` yet, but with a STABLE id so a
 * workspace's persisted copy can be matched against the catalog and reseeded). The
 * service stamps each with `createdAt` + the resolved default flag on first seed;
 * {@link seedModelPresets} lists the built-ins. Mirrors {@link RiskPolicySeed} /
 * the pipeline seed shape, including the monotonic `version` that drives the "reseed
 * available" advisory. WHICH built-in is the workspace default is a DEPLOYMENT fact
 * (see {@link DEFAULT_MODEL_PRESET_ID}), not baked into the seed.
 */
export interface ModelPresetSeed {
  /** Stable catalog id (e.g. `mdp_kimi`), used to match a stored copy for reseeding. */
  id: string
  name: string
  baseModelId: string
  overrides: Record<string, string>
  /**
   * Monotonic seed version. When the current catalog version for this id exceeds a
   * workspace's persisted copy, the SPA offers to reseed it. Bump this when a built-in's
   * definition changes upstream so existing workspaces are advised to adopt the update.
   */
  version: number
}

/** The stable catalog ids for the built-in model presets (used to seed + wire the deployment default). */
export const MODEL_PRESET_SEED_IDS = {
  kimi: 'mdp_kimi',
  glm: 'mdp_glm',
  claude: 'mdp_claude',
} as const

/**
 * The built-in model presets seeded for every workspace, using the catalog ids from
 * {@link MODEL_CATALOG}: "Kimi K2.7" (everything `kimi-k2.7`, the Cloudflare-served
 * baseline), "GLM-5.2" (everything `glm`), and "Claude Opus 5" (everything
 * `claude-opus`, run via a Claude subscription or OpenRouter). A workspace always keeps
 * at least these until the operator edits the library. WHICH one is the workspace
 * default is chosen per deployment ({@link DEFAULT_MODEL_PRESET_ID}) at first seed —
 * Cloudflare/Node default to Kimi (Cloudflare-runnable on the bare baseline), local mode
 * to Claude. To ship a new built-in (or a new version of one), add it here / bump its
 * `version`; existing workspaces are then advised to reseed.
 */
export const DEFAULT_MODEL_PRESETS: ModelPresetSeed[] = [
  {
    id: MODEL_PRESET_SEED_IDS.kimi,
    name: 'Kimi K2.7',
    baseModelId: 'kimi-k2.7',
    overrides: {},
    version: 1,
  },
  { id: MODEL_PRESET_SEED_IDS.glm, name: 'GLM-5.2', baseModelId: 'glm', overrides: {}, version: 1 },
  {
    id: MODEL_PRESET_SEED_IDS.claude,
    name: 'Claude Opus 5',
    baseModelId: 'claude-opus',
    overrides: {},
    // v2: `claude-opus` rolled forward from Opus 4.8 to Opus 5, so the preset's NAME
    // changed. Bumping the version surfaces the reseed advisory to workspaces still
    // holding the "Claude Opus 4.8"-named copy.
    version: 2,
  },
]

/**
 * The catalog fallback default preset id (Kimi K2.7 — Cloudflare-runnable on the bare
 * baseline), used when a deployment doesn't specify its own default preset id. A facade
 * overrides it at seed time (local mode → Claude); the passed default only applies to a
 * workspace whose library hasn't been seeded yet, so a user's later manual choice always
 * wins.
 */
export const DEFAULT_MODEL_PRESET_ID: string = MODEL_PRESET_SEED_IDS.kimi

/** The built-in model presets, fresh copies so callers can stamp ids/timestamps safely. */
export function seedModelPresets(): ModelPresetSeed[] {
  return DEFAULT_MODEL_PRESETS.map((p) => ({ ...p, overrides: { ...p.overrides } }))
}

/** The catalog fallback default preset (everything Kimi K2.7), used as the resolution fallback. */
export const DEFAULT_MODEL_PRESET: ModelPresetSeed =
  DEFAULT_MODEL_PRESETS.find((p) => p.id === DEFAULT_MODEL_PRESET_ID) ?? DEFAULT_MODEL_PRESETS[0]!

/**
 * The model id a preset assigns to an agent kind: its per-kind override, else the
 * preset's base model. When no preset is resolved (a workspace not yet seeded), falls
 * back to the catalog {@link DEFAULT_MODEL_PRESET} (everything Kimi K2.7) — a
 * Cloudflare-runnable default that holds even before the preset library is materialised.
 */
export function modelForKindFromPreset(
  preset: ModelPreset | ModelPresetSeed | null | undefined,
  agentKind: string,
): string {
  const p = preset ?? DEFAULT_MODEL_PRESET
  return presetOverrideForKind(p, agentKind) ?? p.baseModelId
}

/**
 * The model a preset NAMES for an agent kind, or undefined when it says nothing about that kind
 * and {@link modelForKindFromPreset} would answer with its base model.
 *
 * The distinction the two answers collapse is load-bearing for anything that carries a model
 * default of its own (a judge registration pins the model its rubric was authored for): a base
 * model is a blanket statement about every kind, so losing to it would make such a default
 * unreachable, while an override NAMES the kind and must win.
 */
export function presetOverrideForKind(
  preset: ModelPreset | ModelPresetSeed | null | undefined,
  agentKind: string,
): string | undefined {
  return (preset ?? DEFAULT_MODEL_PRESET).overrides[agentKind]
}

/** Human-facing label per block type, used when titling freshly dropped frames. */
export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  frontend: 'Frontend',
  service: 'Service',
  library: 'Library',
  document: 'Document repository',
  api: 'API',
  database: 'Database',
  queue: 'Queue',
  integration: 'Integration',
  external: 'External',
  environment: 'Environment',
}
