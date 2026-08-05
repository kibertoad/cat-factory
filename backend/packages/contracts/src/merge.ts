import * as v from 'valibot'
import { stepGatingSchema } from './consensus.js'
import {
  changeClassSchema,
  RULEABLE_CHANGE_CLASSES,
  type ChangeClass,
  type RuleableChangeClass,
} from './mergeTrackRecord.js'
import { DEFAULT_JUDGE_MAX_BOUNCES, DEFAULT_JUDGE_MIN_SCORE } from './judge.js'
import { WORKSPACE_ROLES, workspaceRoleSchema, type WorkspaceRole } from './workspace-members.js'

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
export const MERGE_CLASS_RULES = ['thresholds', 'always', 'never'] as const

export const mergeClassRuleSchema = v.picklist(MERGE_CLASS_RULES)
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
 * Composition is NARROW-ONLY ({@link narrowMergeClassRule}): a role entry may only make a
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
export type DryRunRoles = v.InferOutput<typeof dryRunRolesSchema>

/** A picklist over the classes a rule (or an allowlist entry) may be authored for. */
const ruleableChangeClassSchema = v.picklist(RULEABLE_CHANGE_CLASSES)

/**
 * The change classes a preset will LAND at all for a given role: a partial map from
 * {@link workspaceRoleSchema} to the list of classes that role's runs may submit.
 *
 * This is the third role-scoped setting, and it answers a question neither of its siblings can.
 * `classRulesByRole` with `never` routes a class to a human, but the human it routes to may be
 * the initiator themselves: the review card carries a merge button and the RBAC write floor is
 * `member`, so a member's run can raise its own card and land on the next tap. `dryRunRoles`
 * closes that by refusing both exits, but only for EVERY class at once. Between them sits the
 * thing a workspace most often wants to say: a product manager may land copy and dependency
 * bumps on this service, and may not land source, however good the scores look.
 *
 * Three readings define it, and each is deliberate:
 *
 *  - **An ALLOWLIST, never a denylist.** A class nobody thought about is OUTSIDE the list, so a
 *    class added to the vocabulary in a later release is refused for a scoped role rather than
 *    silently landed by it. Same safety property as {@link narrowMergeClassRule}: authoring one
 *    can subtract capability, never add it.
 *  - **Absent means UNRESTRICTED, not empty.** Silence is not an empty allowlist, exactly as an
 *    absent class is not a `thresholds` rule in {@link classRulesByRoleSchema}. Only a role
 *    somebody wrote an entry for is scoped, so `{}` is the identity the wire contract says it is
 *    (and an EMPTY array is a real, different policy: that role lands nothing).
 *  - **`unknown` is INERT.** An unreadable diff must not hold back a run that would otherwise
 *    have landed, the same reading `resolveMergeClassRule` takes: a VCS outage cannot change
 *    policy. This is the OPPOSITE direction from the first reading, and deliberately so: a class
 *    we have never heard of is a policy gap, while a class we could not READ is an outage, and
 *    only one of those is evidence about the change.
 */
export const submissionClassesByRoleSchema = v.partial(
  // STRICT for the same reason both rule maps are: a caller who thinks they authored an
  // allowlist must not be told it worked when the role name was a typo.
  v.strictObject(
    Object.fromEntries(WORKSPACE_ROLES.map((r) => [r, v.array(ruleableChangeClassSchema)])) as {
      [K in (typeof WORKSPACE_ROLES)[number]]: v.ArraySchema<
        typeof ruleableChangeClassSchema,
        undefined
      >
    },
  ),
)
export type SubmissionClassesByRole = v.InferOutput<typeof submissionClassesByRoleSchema>

/**
 * How much review a rule DEMANDS, higher is stricter. The ordering is the point of the scale:
 * `always` merges with nothing consulted, `thresholds` merges only within the score ceilings, and
 * `never` merges nothing, so it is total and every pair has a strictest member.
 *
 * A plain rank rather than a `Record<MergeClassRule, number>` of opaque numbers used once: this is
 * the only place the three rules are ORDERED, and {@link narrowMergeClassRule} is the only
 * consumer, so the two are kept adjacent and a new rule fails the typecheck here first.
 */
const MERGE_CLASS_RULE_STRICTNESS: Record<MergeClassRule, number> = {
  always: 0,
  thresholds: 1,
  never: 2,
}

/**
 * Compose a base rule with a ROLE's rule, taking the STRICTER of the two.
 *
 * Narrow-only is the whole safety property of role-scoped rules, and it is enforced here rather
 * than trusted to whoever authors a preset: a role entry can subtract capability but can never add
 * it, so `{ source: 'always' }` under `viewer` on a preset whose base holds `source` at
 * `thresholds` grants a viewer nothing. It reads as a mistake and behaves as a no-op, instead of
 * quietly becoming the widest rule in the preset for its least-trusted tier.
 *
 * The consequence worth stating: a role entry is REVIEWABLE ON ITS OWN. Reading one tells you what
 * that role at most may do, with no need to hold the base map in your head at the same time.
 *
 * It lives in contracts rather than in kernel because the SPA's preset editor has to agree with the
 * engine about it: an authoring surface that offered a role a rule the engine will discard would be
 * telling an operator they had written a policy that does nothing.
 */
export function narrowMergeClassRule(base: MergeClassRule, role: MergeClassRule): MergeClassRule {
  return MERGE_CLASS_RULE_STRICTNESS[role] > MERGE_CLASS_RULE_STRICTNESS[base] ? role : base
}

/**
 * Whether a preset's {@link dryRunRolesSchema} sandboxes a run started under `role`.
 *
 * The rule worth naming is the null case: an unattributed run (a schedule fire, a public-API start,
 * auth-disabled dev) pins no role, cannot match an entry, and is therefore never force-sandboxed.
 * Shared with the SPA so a start control can say "your runs on this task are sandboxed" using the
 * same reading the engine makes at admission, rather than a restated `includes` that would have to
 * re-decide what an absent role means.
 */
export function dryRunForcedForRole(
  dryRunRoles: readonly WorkspaceRole[] | null | undefined,
  role: WorkspaceRole | null | undefined,
): boolean {
  return !!role && !!dryRunRoles?.includes(role)
}

/**
 * The allowlist that governs one run, or `undefined` when nothing does.
 *
 * Kept apart from {@link submissionAllowedForRole} because the two questions differ: "is this run
 * scoped at all" decides whether the merge path owes a classification (one VCS call), and only
 * then does "may it land THIS class" have anything to compare. Reading the boolean first and the
 * verdict second is what keeps an unscoped preset paying for neither.
 */
export function submissionAllowlistForRole(
  byRole: SubmissionClassesByRole | null | undefined,
  role: WorkspaceRole | null | undefined,
): readonly RuleableChangeClass[] | undefined {
  // A run with no pinned role matches no entry, exactly as `dryRunForcedForRole` reads one: a
  // schedule fire / public-API start / auth-disabled dev is not a tier, and treating it as one
  // would scope every unattributed run in a deployment the day somebody first scopes a role.
  if (!role) return undefined
  return byRole?.[role]
}

/**
 * Whether a preset lets a run started by `role` LAND a change of `changeClass`.
 *
 * Every absence answers `true`, and each for its own reason: no pinned role matches no entry, a
 * role with no authored entry is unrestricted, and an `unknown` class is an unreadable diff
 * rather than evidence about the change. Only a role that HAS an allowlist, on a diff that
 * classified, can be refused, and then the list is exhaustive, so a class outside it is refused
 * whether the operator excluded it on purpose or the vocabulary gained it after they wrote the
 * policy.
 *
 * It lives in contracts, beside the map it reads, because the SPA has to state the same verdict:
 * a merge control that offered to land a change the engine will refuse would be advertising a
 * capability the person does not have.
 */
export function submissionAllowedForRole(
  byRole: SubmissionClassesByRole | null | undefined,
  role: WorkspaceRole | null | undefined,
  changeClass: ChangeClass,
): boolean {
  if (changeClass === 'unknown') return true
  const allowed = submissionAllowlistForRole(byRole, role)
  return !allowed || allowed.includes(changeClass)
}

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
  /**
   * Per-ROLE allowlist of the change classes this preset will land at all
   * ({@link submissionClassesByRoleSchema}). Orthogonal to `classRulesByRole`, and both apply: a
   * class may be `always` under the role's class rules and still outside its allowlist, and the
   * allowlist wins, because it bars landing rather than deciding how much review landing takes.
   * A role with no entry is unrestricted, so `{}` is the identity. Empty on the built-ins.
   */
  submissionClassesByRole: submissionClassesByRoleSchema,
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
  /** Per-role allowlist of landable change classes; absent ⇒ every role is unrestricted. */
  submissionClassesByRole: v.optional(submissionClassesByRoleSchema, {}),
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
  /** Replaces the whole map, so un-scoping a role is a plain omission (never an empty array). */
  submissionClassesByRole: v.optional(submissionClassesByRoleSchema),
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
  /**
   * The change classes the initiator's role may land at all, recorded whenever that role carried
   * a submission allowlist, not only when the allowlist is what held the PR back.
   *
   * Present-means-scoped is the useful reading here (the opposite of `roleRule` above, which is
   * recorded only when it changed the outcome): an allowlist that PERMITTED this class is the
   * fact that explains why an otherwise identical PR on another class will not land, and a
   * banner that mentioned the scope only on the refusal would make the permission look like an
   * absence of policy.
   */
  submissionClasses: v.optional(v.array(ruleableChangeClassSchema)),
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
   *  - `submission_not_allowed`: review; the initiator's role carries a submission allowlist and
   *    this run's change class is outside it, so the platform will not land the work whatever the
   *    scores or the class rules say. Kept apart from `role_requires_review` because the remedies
   *    differ in kind: that one is satisfied by ANY reviewer merging the PR through this
   *    platform, while this one refuses the platform merge path outright (the PR is still a real
   *    PR, and someone with write access on the host can merge it there).
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
    'submission_not_allowed',
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
