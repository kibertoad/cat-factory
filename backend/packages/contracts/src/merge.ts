import * as v from 'valibot'
import { stepGatingSchema } from './consensus.js'
import { changeClassSchema, RULEABLE_CHANGE_CLASSES } from './mergeTrackRecord.js'
import { DEFAULT_JUDGE_MAX_BOUNCES, DEFAULT_JUDGE_MIN_SCORE } from './judge.js'
import { WORKSPACE_ROLES, workspaceRoleSchema } from './workspace-members.js'

// ---------------------------------------------------------------------------
// Merge-policy wire contracts. After a pipeline's implementation work is done
// and CI is green, a `merger` agent assesses the pull request along three axes —
// complexity, risk and impact (each scored 0..1) — and the engine compares those
// scores against the task's resolved *merge threshold preset*. If every score is
// at or below its configured ceiling the PR is merged automatically; otherwise a
// `merge_review` notification is raised for a human to act on.
//
// Presets are authored per workspace (a small library of named policies, e.g.
// "Cautious", "Trusted") and one is selected per task; a task with no explicit
// selection resolves to the workspace's default preset. The preset also carries
// the CI-fixer attempt budget (how many times the `ci-fixer` agent may try to get
// CI green before the run gives up).
// ---------------------------------------------------------------------------

/**
 * A `merger` agent's structured assessment of a pull request. Each axis is scored
 * 0..1 (higher = more complex / riskier / higher blast-radius); `rationale` is the
 * agent's prose justification, surfaced to a human when the PR needs review.
 */
/**
 * The severity threshold a task tolerates from the requirements reviewer before it stops
 * for a human. Mirrors the review item severities (`low`/`medium`/`high`) plus `none`,
 * which tolerates nothing. Ordered none < low < medium < high.
 */
export const requirementConcernLevelSchema = v.picklist(['none', 'low', 'medium', 'high'])
export type RequirementConcernLevel = v.InferOutput<typeof requirementConcernLevelSchema>

/** Rank of a {@link RequirementConcernLevel} for "at or below" comparisons. */
export const REQUIREMENT_CONCERN_RANK: Record<RequirementConcernLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
}

// ---------------------------------------------------------------------------
// Per-CLASS auto-merge rules. The score ceilings below apply uniformly to every
// change, which leaves a workspace unable to express "auto-merge dependency bumps
// and docs, always review schema changes". A preset therefore also carries an
// optional rule per {@link ChangeClass}, resolved against the run's deterministic,
// path-derived classification. See `docs/initiatives/merge-track-record.md`.
// ---------------------------------------------------------------------------

/**
 * What a preset does with a pull request of a given change class:
 *
 *  - `thresholds` — compare the merger's scores against this preset's ceilings (the default,
 *    and what an ABSENT entry means, so `{}` behaves exactly like no rules at all).
 *  - `always`     — auto-merge regardless of the scores.
 *  - `never`      — always route to a human, regardless of the scores.
 */
export const mergeClassRuleSchema = v.picklist(['thresholds', 'always', 'never'])
export type MergeClassRule = v.InferOutput<typeof mergeClassRuleSchema>

/**
 * A preset's per-class rules: a PARTIAL map from change class to its rule. An absent class
 * means `thresholds`, so an empty object is the "behave exactly as before" identity.
 *
 * `unknown` is deliberately NOT a member: an unclassifiable diff (no VCS client wired, a
 * transient provider outage) must fall back to the score thresholds rather than silently
 * adopt a widened policy. See `RULEABLE_CHANGE_CLASSES`.
 */
export const mergeClassRulesSchema = v.partial(
  // STRICT: an unknown key (notably `unknown`, which no rule may ever match) is a 400 rather than
  // being silently stripped. A caller who thinks they authored a rule must not be told it worked.
  v.strictObject(
    Object.fromEntries(RULEABLE_CHANGE_CLASSES.map((c) => [c, mergeClassRuleSchema])) as {
      [K in (typeof RULEABLE_CHANGE_CLASSES)[number]]: typeof mergeClassRuleSchema
    },
  ),
)
export type MergeClassRules = v.InferOutput<typeof mergeClassRulesSchema>

/**
 * ROLE-SCOPED per-class rules: the rules above, narrowed by WHO started the run.
 *
 * A partial map from {@link workspaceRoleSchema} to that role's own {@link mergeClassRulesSchema}.
 * The base `classRules` say what the WORK may do; this says what a given tier of person may do
 * with it, so a workspace can widen `dependency` to `always` for everyone and still hold a
 * non-developer's runs to review on `source`.
 *
 * Composition is NARROW-ONLY (`narrowMergeClassRule` in kernel): a role entry may only make a
 * class MORE restrictive than the base rule, never less. That is the whole safety property — an
 * allowlist authored per role can subtract capability but can never hand a role something the
 * preset itself withholds, so a role entry can be reviewed on its own without re-reading the base
 * map. `unknown` stays unruleable here for the same reason it is in the base map.
 *
 * A role with no entry is exactly the base rules, so `{}` is the identity. So is a run with no
 * pinned role (a schedule fire, a public-API start, auth-disabled dev): see
 * {@link ExecutionInstance.initiatedByRole} for why those are left on the base policy rather than
 * guessed onto a tier.
 */
export const classRulesByRoleSchema = v.partial(
  // STRICT for the same reason the base map is: a caller who thinks they authored a rule for a
  // role must not be told it worked when the role name was a typo.
  v.strictObject(
    Object.fromEntries(WORKSPACE_ROLES.map((r) => [r, mergeClassRulesSchema])) as {
      [K in (typeof WORKSPACE_ROLES)[number]]: typeof mergeClassRulesSchema
    },
  ),
)
export type ClassRulesByRole = v.InferOutput<typeof classRulesByRoleSchema>

/**
 * The roles whose runs are FORCED into dry-run mode ({@link RunMode}) by this preset: every run
 * such a role starts does the work and opens its PR, but nothing merges — not automatically, and
 * not through the manual merge endpoint either.
 *
 * This is the "sandboxed run for a non-developer" setting. It is expressed on the preset rather
 * than on the role catalog because it is a POLICY about a body of work (this service's tasks),
 * not a capability of the person: the same product manager may be trusted to land copy changes on
 * one service and nothing at all on another, and the preset is already what a task selects.
 *
 * Empty on every built-in, so the default is byte-for-byte the historical behaviour. A role that
 * cannot start runs at all (`viewer`, which holds no `runs.execute`) may be listed without effect.
 */
export const dryRunRolesSchema = v.array(workspaceRoleSchema)

export const mergeAssessmentSchema = v.object({
  /** How intricate the change is (size, coupling, subtlety). */
  complexity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Likelihood the change breaks something (test coverage, fragility). */
  risk: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Blast radius if it does break (how much/who it affects). */
  impact: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** The agent's plain-prose justification for the scores + a merge recommendation. */
  rationale: v.string(),
})
export type MergeAssessment = v.InferOutput<typeof mergeAssessmentSchema>

/**
 * A named, per-workspace merge policy: the upper bounds (0..1) a PR's assessment
 * must stay within to auto-merge, plus the CI-fixer attempt budget. Exactly one
 * preset per workspace is the default (`isDefault`), used by any task that has not
 * picked one explicitly.
 */
export const riskPolicySchema = v.object({
  id: v.string(),
  name: v.string(),
  /** Auto-merge only when the assessment's complexity is at or below this. */
  maxComplexity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Auto-merge only when the assessment's risk is at or below this. */
  maxRisk: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Auto-merge only when the assessment's impact is at or below this. */
  maxImpact: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** How many times the `ci-fixer` agent may try to turn CI green before giving up. */
  ciMaxAttempts: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * How many reviewer passes the iterative requirements-review loop may run before it
   * stops on its own and asks the human to pick (extra round / proceed anyway / reset the
   * task). One reviewer pass = one iteration; the initial review counts as iteration 1.
   */
  maxRequirementIterations: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * The highest finding severity the requirements review tolerates WITHOUT stopping. When
   * every outstanding finding from a reviewer pass is at or below this level, the findings
   * are recorded but the run does NOT pause for human approval — the incorporation
   * companion is skipped and the next pipeline step runs automatically. `none` (the
   * default) tolerates nothing, so any finding pauses for a human; `high` tolerates
   * everything. Severity order: none < low < medium < high.
   */
  maxRequirementConcernAllowed: requirementConcernLevelSchema,
  /**
   * How many times the test quality-control companion may loop the Tester for a more
   * complete report before it stops gating and lets the run proceed to the greenlight /
   * fixer decision. One QC-driven Tester re-run = one iteration, so this is the maximum
   * number of QC re-runs: `1` permits a single re-run before the gate gives up. Independent
   * of the `ciMaxAttempts` fixer budget.
   */
  maxTesterQualityIterations: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * How long (minutes) the post-release-health gate watches the deployed release's
   * Datadog monitors/SLOs before declaring it healthy and advancing.
   */
  releaseWatchWindowMinutes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * How many `on-call` investigations the post-release-health gate may dispatch while
   * watching before it gives up and raises a notification. The on-call agent investigates
   * rather than fixing prod, so 1 is the sensible default.
   */
  releaseMaxAttempts: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * How long (minutes) the `human-review` gate waits after the latest review comment before
   * dispatching the `fixer` to address the batch — a grace window so a reviewer leaving a
   * series of comments isn't churned mid-stream. Only the unapproved path waits; an approved
   * PR's outstanding comments are addressed immediately.
   */
  humanReviewGraceMinutes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * The minimum score (0..1) a JUDGE step's verdict must reach for the run to advance
   * without a human. Below it, the judge applies its registration's `onFail` disposition
   * (park / bounce / fail). The per-task counterpart of `maxRequirementConcernAllowed`:
   * how much rubric deviation THIS task tolerates. See `docs/initiatives/judge-registry.md`.
   */
  judgeMinScore: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /**
   * How many BOUNCE rounds a judge may spend — re-arming the preceding producing step with
   * the verdict's findings as rework feedback — before it must stop and ask a human. `0`
   * means never bounce (a failing verdict goes straight to the registration's park/fail).
   */
  judgeMaxBounces: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * When false the `merger` step never auto-merges: every PR is routed to a human
   * `merge_review` notification regardless of the assessment scores. The built-in
   * "Manual review only" preset sets this; a custom preset may too. Defaults to true
   * (the historical behaviour: auto-merge a within-threshold, explained assessment).
   */
  autoMergeEnabled: v.boolean(),
  /**
   * Estimate gating for the optional implementation-fork decision phase on the Coder step
   * (the same three axes / `onMissingEstimate` as any other {@link stepGatingSchema}). When
   * present and `enabled`, a task whose Coder config resolves to `auto` surfaces materially
   * different implementation approaches and parks for a human whenever ANY supplied axis of
   * its estimate is met/exceeded; `onMissingEstimate: 'run'` proposes even without an
   * estimate (fail toward asking). Absent/disabled ⇒ fork surfacing is off in `auto` mode
   * (a task can still force it via its `always` tri-state). Disabled by default on the
   * built-in presets.
   */
  forkDecision: v.optional(v.nullable(stepGatingSchema)),
  /**
   * Per-change-class auto-merge rules ({@link mergeClassRulesSchema}). An absent class — and
   * therefore an empty object — means "use the score ceilings above", so `{}` is the identity.
   * A rule NEVER overrides `autoMergeEnabled: false`: that master switch wins first.
   */
  classRules: mergeClassRulesSchema,
  /**
   * Per-ROLE narrowing of `classRules` ({@link classRulesByRoleSchema}), keyed on the workspace
   * role the run's initiator held when it was admitted. Narrow-only, so an empty map is the
   * identity and a role entry can never widen what `classRules` already allows.
   */
  classRulesByRole: classRulesByRoleSchema,
  /**
   * Roles whose runs are forced into dry-run mode ({@link dryRunRolesSchema}) — the work happens
   * and the PR opens, but nothing merges. Empty on the built-ins.
   */
  dryRunRoles: dryRunRolesSchema,
  /** The workspace's fallback preset, used by tasks that pick none. Exactly one is true. */
  isDefault: v.boolean(),
  /**
   * Monotonic seed version for a BUILT-IN preset (`seedRiskPolicies()` assigns it). When the
   * current catalog version for this id exceeds the persisted copy's `version`, the SPA offers
   * to reseed it. Absent on user-created presets (not version-tracked) and on rows persisted
   * before versioning existed (treated as 0).
   */
  version: v.optional(v.number()),
  createdAt: v.number(),
})
export type RiskPolicy = v.InferOutput<typeof riskPolicySchema>

// ---- Request bodies -------------------------------------------------------

const presetNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60))
const scoreSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1))
const attemptsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(50))
const iterationsSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20))
const releaseWindowSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(720))
const releaseAttemptsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10))
const graceMinutesSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1440))
const bouncesSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10))

/** Create a new merge threshold preset in a workspace. */
export const createRiskPolicySchema = v.object({
  name: presetNameSchema,
  maxComplexity: scoreSchema,
  maxRisk: scoreSchema,
  maxImpact: scoreSchema,
  ciMaxAttempts: attemptsSchema,
  maxRequirementIterations: iterationsSchema,
  maxRequirementConcernAllowed: requirementConcernLevelSchema,
  maxTesterQualityIterations: v.optional(iterationsSchema, 3),
  releaseWatchWindowMinutes: v.optional(releaseWindowSchema, 30),
  releaseMaxAttempts: v.optional(releaseAttemptsSchema, 1),
  humanReviewGraceMinutes: v.optional(graceMinutesSchema, 10),
  judgeMinScore: v.optional(scoreSchema, DEFAULT_JUDGE_MIN_SCORE),
  judgeMaxBounces: v.optional(bouncesSchema, DEFAULT_JUDGE_MAX_BOUNCES),
  /** Allow auto-merge of a within-threshold, explained assessment (default true). */
  autoMergeEnabled: v.optional(v.boolean(), true),
  /** Estimate gating for the implementation-fork decision phase; absent ⇒ off in `auto` mode. */
  forkDecision: v.optional(v.nullable(stepGatingSchema)),
  /** Per-change-class auto-merge rules; absent ⇒ every class uses the score ceilings. */
  classRules: v.optional(mergeClassRulesSchema, {}),
  /** Per-role narrowing of `classRules`; absent ⇒ every role uses the rules above unchanged. */
  classRulesByRole: v.optional(classRulesByRoleSchema, {}),
  /** Roles whose runs are forced into dry-run mode; absent ⇒ nobody is sandboxed. */
  dryRunRoles: v.optional(dryRunRolesSchema, []),
  /** Make this the workspace default (demotes the previous default). */
  isDefault: v.optional(v.boolean(), false),
})
export type CreateRiskPolicyInput = v.InferOutput<typeof createRiskPolicySchema>

/** Patch an existing merge threshold preset (all fields optional). */
export const updateRiskPolicySchema = v.object({
  name: v.optional(presetNameSchema),
  maxComplexity: v.optional(scoreSchema),
  maxRisk: v.optional(scoreSchema),
  maxImpact: v.optional(scoreSchema),
  ciMaxAttempts: v.optional(attemptsSchema),
  maxRequirementIterations: v.optional(iterationsSchema),
  maxRequirementConcernAllowed: v.optional(requirementConcernLevelSchema),
  maxTesterQualityIterations: v.optional(iterationsSchema),
  releaseWatchWindowMinutes: v.optional(releaseWindowSchema),
  releaseMaxAttempts: v.optional(releaseAttemptsSchema),
  humanReviewGraceMinutes: v.optional(graceMinutesSchema),
  judgeMinScore: v.optional(scoreSchema),
  judgeMaxBounces: v.optional(bouncesSchema),
  autoMergeEnabled: v.optional(v.boolean()),
  forkDecision: v.optional(v.nullable(stepGatingSchema)),
  /** Replaces the whole rule map (not merged), so clearing a class is a plain omission. */
  classRules: v.optional(mergeClassRulesSchema),
  /** Replaces the whole per-role map (not merged), so clearing a role is a plain omission. */
  classRulesByRole: v.optional(classRulesByRoleSchema),
  /** Replaces the whole list, so un-sandboxing a role is a plain omission. */
  dryRunRoles: v.optional(dryRunRolesSchema),
  isDefault: v.optional(v.boolean()),
})
export type UpdateRiskPolicyInput = v.InferOutput<typeof updateRiskPolicySchema>

/** Parse-or-throw an assessment payload an agent returned (the engine validates it). */
export function parseMergeAssessment(value: unknown): MergeAssessment {
  return v.parse(mergeAssessmentSchema, value)
}

// ---------------------------------------------------------------------------
// Merge DECISION — the engine's resolved verdict for a completed `merger` step,
// persisted on the step (`step.custom`) so the SPA can render the assessment nicely
// AND explain WHY the engine auto-merged or routed the PR to a human. The `merger`
// agent only produces the assessment (scores + rationale); the engine (MergeResolver)
// compares it against the task's resolved preset and records this alongside.
// ---------------------------------------------------------------------------

/** Which assessment axis exceeded its preset ceiling. */
export const mergeAxisSchema = v.picklist(['complexity', 'risk', 'impact'])
export type MergeAxis = v.InferOutput<typeof mergeAxisSchema>

/** The preset ceilings the assessment was compared against (for the decision banner). */
export const mergeDecisionThresholdsSchema = v.object({
  /** The resolved preset's display name (e.g. "Balanced"). */
  presetName: v.string(),
  maxComplexity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  maxRisk: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  maxImpact: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  autoMergeEnabled: v.boolean(),
  /**
   * The rule the preset carried for the run's resolved change class, when one applied —
   * so the decision banner can say "auto-merged because this preset always auto-merges
   * dependency bumps" rather than implying the scores did it. Absent when the class was
   * `unknown` (rules never match it) or the preset left the class on `thresholds`.
   */
  classRule: v.optional(mergeClassRuleSchema),
  /**
   * The workspace role the run's initiator held when the run was ADMITTED, when one was pinned.
   * Absent for an unattributed run (a schedule fire, a public-API start, auth-disabled dev), which
   * is a real and different state from "started by a viewer" — see
   * {@link ExecutionInstance.initiatedByRole}. Recorded so the banner can attribute a narrowed
   * decision to the tier it was narrowed for rather than implying the scores did it.
   */
  initiatorRole: v.optional(workspaceRoleSchema),
  /**
   * The rule after the initiator's role narrowed it, recorded ONLY when the narrowing actually
   * changed the outcome (`roleRule` more restrictive than `classRule`). Absent when the role left
   * the class alone, so its presence always means "this decision would have gone differently for
   * someone else".
   */
  roleRule: v.optional(mergeClassRuleSchema),
})
export type MergeDecisionThresholds = v.InferOutput<typeof mergeDecisionThresholdsSchema>

export const mergeDecisionSchema = v.object({
  /** What the engine did: merged the PR for real, or left it open for a human. */
  outcome: v.picklist(['auto_merged', 'awaiting_review']),
  /**
   * Why — drives the human-readable banner:
   *  - `within_thresholds`: auto-merged; every axis at/below the preset ceiling.
   *  - `exceeded_thresholds`: review; one or more axes over the ceiling (`exceededAxes`).
   *  - `auto_merge_disabled`: review; the preset routes every PR to a human.
   *  - `no_rationale`: review; the merger returned scores but no rationale, so the verdict
   *    can't be trusted to auto-merge (the assessment IS present, just not credible).
   *  - `no_assessment`: review; the merger produced no parseable assessment at all.
   *  - `merge_failed`: review; within threshold but the real merge threw (e.g. branch
   *    protection / conflict), so it fell through to human review.
   *  - `merge_partial`: review; a MULTI-REPO task auto-merged some of its PRs but an
   *    intermediate merge failed (cross-repo merges are non-atomic), so the block is left
   *    blocked with a notification enumerating the merged vs unmerged repos.
   *  - `class_auto_merge`: auto-merged because the preset's rule for the run's change class
   *    is `always` — the scores (and the rationale-credibility backstop) were bypassed by an
   *    explicit operator policy keyed on the DETERMINISTIC backend classification.
   *  - `class_requires_review`: review; the preset's rule for the change class is `never`,
   *    regardless of how low the scores were.
   *  - `role_requires_review`: review; the preset's rule for the change class is permissive
   *    enough, but the initiator's ROLE narrows that class to `never`. Kept distinct from
   *    `class_requires_review` because the two need opposite fixes: one is a policy about the
   *    KIND of change (edit the class rule), the other about WHO started it (a teammate on a
   *    higher tier can merge this PR as it stands).
   *  - `dry_run`: review; the run was a DRY RUN, so no outcome of the assessment could have
   *    merged it. The master switch above every other reason, including `auto_merge_disabled`:
   *    a preset that would otherwise auto-merge must not report a dry run's PR as "held back by
   *    the scores", which would send someone editing thresholds that were never consulted.
   */
  reason: v.picklist([
    'within_thresholds',
    'exceeded_thresholds',
    'auto_merge_disabled',
    'no_rationale',
    'no_assessment',
    'merge_failed',
    'merge_partial',
    'class_auto_merge',
    'class_requires_review',
    'role_requires_review',
    'dry_run',
  ]),
  /** The merger's assessment (absent only when it produced no parseable one). */
  assessment: v.optional(mergeAssessmentSchema),
  thresholds: mergeDecisionThresholdsSchema,
  /** The axes that exceeded their ceiling (empty unless `reason` is `exceeded_thresholds`). */
  exceededAxes: v.array(mergeAxisSchema),
  /**
   * The run's deterministic change class, when classification resolved one. Recorded on the
   * step so the SPA can show WHAT KIND of change the decision was made about (and, with the
   * class's rollup, how that class has historically fared). Absent ⇒ classification did not
   * run (no VCS client wired) — the same state `unknown` denotes on a track record.
   */
  changeClass: v.optional(changeClassSchema),
})
export type MergeDecision = v.InferOutput<typeof mergeDecisionSchema>
