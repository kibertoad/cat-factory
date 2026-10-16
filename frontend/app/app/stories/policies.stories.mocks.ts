// Merge policies (risk policies) and model presets, as the board snapshot carries them. Several
// settings surfaces read both, and so do the startup advisories that offer to reseed a built-in.
//
// The built-ins mirror the backend's seeds (`RISK_POLICY_SEEDS` and `DEFAULT_MODEL_PRESETS` in
// `backend/packages/kernel/src/domain/catalog.ts`): ids, names, versions and the Balanced values.
// The SPA cannot import kernel, so they are copies, and a copy can go stale.
import {
  DEFAULT_COMPANION_MAX_ATTEMPTS,
  DEFAULT_JUDGE_MAX_BOUNCES,
  DEFAULT_JUDGE_MIN_SCORE,
  DEFAULT_MIN_AUTO_ANSWER_CONFIDENCE,
  type ModelPreset,
  type RiskPolicyLibraryEntry,
} from '@cat-factory/contracts'

/** The built-in policy ids and their current catalog versions. */
export const riskPolicyCatalogVersions: Record<string, number> = {
  mp_balanced: 6,
  mp_unattended: 1,
  mp_manual_review: 6,
}

/** The Balanced built-in on this board, at its current version. */
export function riskPolicy(
  overrides: Partial<RiskPolicyLibraryEntry> = {},
): RiskPolicyLibraryEntry {
  return {
    id: 'mp_balanced',
    name: 'Balanced',
    maxComplexity: 0.5,
    maxRisk: 0.4,
    maxImpact: 0.5,
    ciMaxAttempts: 10,
    maxRequirementIterations: 6,
    maxRequirementConcernAllowed: 'none',
    maxTesterQualityIterations: 3,
    companionMaxReworks: DEFAULT_COMPANION_MAX_ATTEMPTS,
    releaseWatchWindowMinutes: 30,
    releaseMaxAttempts: 1,
    humanReviewGraceMinutes: 10,
    judgeMinScore: DEFAULT_JUDGE_MIN_SCORE,
    judgeMaxBounces: DEFAULT_JUDGE_MAX_BOUNCES,
    autoMergeEnabled: true,
    forkDecision: {
      enabled: false,
      minComplexity: 0.5,
      minRisk: 0.4,
      minImpact: 0.4,
      onMissingEstimate: 'run',
    },
    classRules: {},
    classRulesByRole: {},
    dryRunRoles: [],
    submissionClassesByRole: {},
    autonomy: 'attended',
    minAutoAnswerConfidence: DEFAULT_MIN_AUTO_ANSWER_CONFIDENCE,
    isDefault: true,
    isUnattendedDefault: false,
    version: 6,
    createdAt: Date.UTC(2026, 8, 1),
    tier: 'workspace',
    ...overrides,
  }
}

/** Manual review only: auto-merge off, so every pull request waits for a person. */
export const manualReviewPolicy = riskPolicy({
  id: 'mp_manual_review',
  name: 'Manual review only',
  autoMergeEnabled: false,
  isDefault: false,
})

/** The built-in preset ids, their current catalog versions and their names. */
/** An account policy a board inherits: auto-merge on, with lower ceilings than the default. */
export const accountStrictPolicy = riskPolicy({
  id: 'mp_acme_strict',
  name: 'Acme strict',
  maxRisk: 0.2,
  maxImpact: 0.3,
  isDefault: false,
  version: 1,
  tier: 'account',
})

export const modelPresetCatalogVersions: Record<string, number> = {
  mdp_kimi: 1,
  mdp_glm: 1,
  mdp_claude: 2,
  mdp_chatgpt: 1,
}
export const modelPresetCatalogNames: Record<string, string> = {
  mdp_kimi: 'Kimi K2.7',
  mdp_glm: 'GLM-5.2',
  mdp_claude: 'Claude Opus 5',
  mdp_chatgpt: 'GPT-5.6 Sol',
}

/** The Kimi built-in, the default preset on a Cloudflare or Node deployment. */
export function modelPreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
  return {
    id: 'mdp_kimi',
    name: 'Kimi K2.7',
    baseModelId: 'kimi-k2.7',
    overrides: {},
    isDefault: true,
    version: 1,
    createdAt: Date.UTC(2026, 8, 1),
    ...overrides,
  }
}

/**
 * A board's preset library: the four built-ins, Kimi the default, and the board's own preset,
 * which runs the reviewers on Claude and prefers the Claude subscription over Workers AI.
 */
export const modelPresetLibrary: ModelPreset[] = [
  modelPreset(),
  modelPreset({ id: 'mdp_glm', name: 'GLM-5.2', baseModelId: 'glm', isDefault: false }),
  modelPreset({
    id: 'mdp_claude',
    name: 'Claude Opus 5',
    baseModelId: 'claude-opus',
    isDefault: false,
    version: 2,
  }),
  modelPreset({
    id: 'mdp_chatgpt',
    name: 'GPT-5.6 Sol',
    baseModelId: 'gpt-5.6-sol',
    isDefault: false,
  }),
  {
    id: 'mdp_reviews_on_claude',
    name: 'Reviews on Claude',
    baseModelId: 'kimi-k2.7',
    overrides: { reviewer: 'claude-opus', 'pr-reviewer': 'claude-opus' },
    isDefault: false,
    providerPreference: ['subscription', 'cloudflare'],
    createdAt: Date.UTC(2026, 9, 3),
  },
]
