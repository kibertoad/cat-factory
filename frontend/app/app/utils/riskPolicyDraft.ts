import { DEFAULT_COMPANION_MAX_ATTEMPTS, type StepGating } from '@cat-factory/contracts'
import type {
  ClassRulesByRole,
  DryRunRoles,
  MergeClassRules,
  RequirementConcernLevel,
  RiskPolicy,
  SubmissionClassesByRole,
  UpdateRiskPolicyInput,
} from '~/types/merge'
import type { RiskPolicyAxis } from '~/utils/riskPolicy'

/**
 * The editable form state behind one risk policy, and the conversions either side of it.
 *
 * Extracted out of the settings panel because the SAME form now serves two tiers (a board's own
 * policies and an account's, ADR 0055) plus the create row, and three copies of "percentages are
 * edited 0..100 and stored 0..1" is three chances for one of them to drift by a factor of a hundred.
 */
export interface RiskPolicyDraft {
  name: string
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  ciMaxAttempts: number
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
  /**
   * How many automatic rework rounds a companion (reviewer / architect-companion /
   * spec-companion) may drive before the run parks for a person. `0` sends the first verdict below
   * the bar straight to that park, which is a posture rather than a disabled loop.
   */
  companionMaxReworks: number
  autoMergeEnabled: boolean
  /**
   * Whether a run under this policy answers the parks its own automatic loops raise when they give
   * up, rather than stopping for a person. Edited as a switch because the vocabulary is two-valued
   * and the OFF state is the historical behaviour.
   */
  unattended: boolean
  /**
   * The confidence floor an unattended run's auto-answered requirements finding must clear, as a
   * PERCENT (like the numbers above). Only read while `unattended` is on.
   */
  minAutoAnswerConfidence: number
  /**
   * Per-change-class auto-merge rules. An OMITTED class means "use the score ceilings above", so
   * `{}` is the identity.
   */
  classRules: MergeClassRules
  /**
   * The ROLE layer over those rules: per-role narrowing (narrow-only, so `{}` is the identity) and
   * the roles whose runs are sandboxed. Both replace the stored value wholesale on save, which is
   * why clearing one in the editor is a plain omission.
   */
  classRulesByRole: ClassRulesByRole
  dryRunRoles: DryRunRoles
  /**
   * Which classes each role may LAND at all. A role with no entry is unrestricted, so `{}` is the
   * identity; an entry with no classes is the different policy that the role lands nothing.
   */
  submissionClassesByRole: SubmissionClassesByRole
  /** Implementation-fork decision gating (edited 0..100, stored 0..1); disabled ⇒ off in `auto`. */
  forkEnabled: boolean
  forkMinComplexity: number
  forkMinRisk: number
  forkMinImpact: number
  forkOnMissing: 'run' | 'skip'
}

/**
 * Which draft field carries each axis's fork FLOOR: the same three axes as the auto-merge ceilings,
 * read as "how big an estimate has to be before the coder stops to propose implementations". Shares
 * the axis order but not the fields, and is exhaustive over the union so adding an axis fails the
 * typecheck rather than silently rendering two.
 */
export const FORK_FLOOR_FIELD: Record<
  RiskPolicyAxis,
  'forkMinRisk' | 'forkMinImpact' | 'forkMinComplexity'
> = {
  risk: 'forkMinRisk',
  impact: 'forkMinImpact',
  complexity: 'forkMinComplexity',
}

/** A stored policy → the form state, percentages scaled up for editing. */
export function toRiskPolicyDraft(p: RiskPolicy): RiskPolicyDraft {
  return {
    name: p.name,
    maxComplexity: Math.round(p.maxComplexity * 100),
    maxRisk: Math.round(p.maxRisk * 100),
    maxImpact: Math.round(p.maxImpact * 100),
    ciMaxAttempts: p.ciMaxAttempts,
    maxRequirementIterations: p.maxRequirementIterations,
    maxRequirementConcernAllowed: p.maxRequirementConcernAllowed,
    companionMaxReworks: p.companionMaxReworks,
    autoMergeEnabled: p.autoMergeEnabled,
    unattended: p.autonomy === 'unattended',
    minAutoAnswerConfidence: Math.round(p.minAutoAnswerConfidence * 100),
    classRules: { ...p.classRules },
    classRulesByRole: { ...p.classRulesByRole },
    dryRunRoles: [...p.dryRunRoles],
    submissionClassesByRole: { ...p.submissionClassesByRole },
    forkEnabled: p.forkDecision?.enabled ?? false,
    forkMinComplexity: Math.round((p.forkDecision?.minComplexity ?? 0.5) * 100),
    forkMinRisk: Math.round((p.forkDecision?.minRisk ?? 0.4) * 100),
    forkMinImpact: Math.round((p.forkDecision?.minImpact ?? 0.4) * 100),
    forkOnMissing: p.forkDecision?.onMissingEstimate ?? 'run',
  }
}

/** The blank draft a create form opens on: the shipped defaults, and never a granted licence. */
export function blankRiskPolicyDraft(): RiskPolicyDraft {
  return {
    name: '',
    maxComplexity: 50,
    maxRisk: 40,
    maxImpact: 50,
    ciMaxAttempts: 10,
    maxRequirementIterations: 6,
    maxRequirementConcernAllowed: 'none',
    // Off the constant the create schema itself defaults to, so the form cannot pre-fill a number
    // the platform has stopped shipping. The percentages above are literals because they are the
    // EDITING scale (0..100) rather than the stored value; this one is stored as typed.
    companionMaxReworks: DEFAULT_COMPANION_MAX_ATTEMPTS,
    autoMergeEnabled: true,
    // A new policy parks on its own caps, matching every built-in but the unattended default: a
    // licence to answer them is a posture somebody grants, never one a blank form assumes.
    unattended: false,
    minAutoAnswerConfidence: 80,
    // The create row authors the numbers only. Class and role rules start at their identity and are
    // edited on the saved policy, where each rule can be shown beside the base rule (and the track
    // record) it narrows — neither reads as anything on a policy that does not exist yet.
    classRules: {},
    classRulesByRole: {},
    dryRunRoles: [],
    submissionClassesByRole: {},
    forkEnabled: false,
    forkMinComplexity: 50,
    forkMinRisk: 40,
    forkMinImpact: 40,
    forkOnMissing: 'run',
  }
}

/** The `StepGating` payload for the fork-decision gate from a draft. */
export function forkGatingFromDraft(d: RiskPolicyDraft): StepGating {
  return {
    enabled: d.forkEnabled,
    minComplexity: d.forkMinComplexity / 100,
    minRisk: d.forkMinRisk / 100,
    minImpact: d.forkMinImpact / 100,
    onMissingEstimate: d.forkOnMissing,
  }
}

/**
 * The form state → the PATCH body, percentages scaled back down.
 *
 * Every role/class map is submitted whole on every save, which is what makes clearing one entry a
 * plain omission (there is no "delete this key" wire shape). `fallbackName` keeps a blanked name
 * field from saving an empty string over a policy that has one.
 */
export function riskPolicyPatchFromDraft(
  d: RiskPolicyDraft,
  fallbackName: string,
): UpdateRiskPolicyInput {
  return {
    name: d.name.trim() || fallbackName,
    maxComplexity: d.maxComplexity / 100,
    maxRisk: d.maxRisk / 100,
    maxImpact: d.maxImpact / 100,
    ciMaxAttempts: d.ciMaxAttempts,
    maxRequirementIterations: d.maxRequirementIterations,
    maxRequirementConcernAllowed: d.maxRequirementConcernAllowed,
    companionMaxReworks: d.companionMaxReworks,
    autoMergeEnabled: d.autoMergeEnabled,
    autonomy: d.unattended ? 'unattended' : 'attended',
    minAutoAnswerConfidence: d.minAutoAnswerConfidence / 100,
    classRules: d.classRules,
    classRulesByRole: d.classRulesByRole,
    dryRunRoles: d.dryRunRoles,
    submissionClassesByRole: d.submissionClassesByRole,
    forkDecision: forkGatingFromDraft(d),
  }
}

/** Per-axis label keys for the auto-merge CEILINGS, iterated in the shared axis order. */
export const CEILING_LABEL_KEYS: Record<RiskPolicyAxis, string> = {
  risk: 'settings.riskPolicy.field.maxRisk',
  impact: 'settings.riskPolicy.field.maxImpact',
  complexity: 'settings.riskPolicy.field.maxComplexity',
}

/** Per-axis label keys for the fork-decision FLOORS. */
export const FORK_FLOOR_LABEL_KEYS: Record<RiskPolicyAxis, string> = {
  risk: 'settings.riskPolicy.forkDecision.minRisk',
  impact: 'settings.riskPolicy.forkDecision.minImpact',
  complexity: 'settings.riskPolicy.forkDecision.minComplexity',
}

/**
 * Per-concern-level label keys for the requirements auto-pass threshold (none < low < medium <
 * high). An exhaustive `Record` keyed off the union, each value a LITERAL catalog key so the
 * typed-message-keys check sees it.
 */
export const CONCERN_LABEL_KEYS: Record<RequirementConcernLevel, string> = {
  none: 'settings.riskPolicy.concern.none',
  low: 'settings.riskPolicy.concern.low',
  medium: 'settings.riskPolicy.concern.medium',
  high: 'settings.riskPolicy.concern.high',
}

/** The concern levels in severity order, for the select. */
export const CONCERN_LEVELS: readonly RequirementConcernLevel[] = ['none', 'low', 'medium', 'high']
