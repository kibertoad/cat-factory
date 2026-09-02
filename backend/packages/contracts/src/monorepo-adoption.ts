import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Monorepo adoption: the wire vocabulary of the human-reviewed step that sits between
// "survey the monorepo and the template" and "write the new service".
//
// Bootstrapping a service INTO an existing monorepo has a decision the from-scratch flow
// never faces: the reference template ships its own build tooling, lint config, test runner,
// CI wiring and layout, and so does the monorepo it is landing in. Every one of those is a
// choice between the template's answer and the house answer, and getting it wrong is
// expensive in both directions: adopting the template wholesale forks the monorepo's
// toolchain, adopting the monorepo wholesale throws away the template's reason to exist.
//
// The platform will not guess. It surveys both sides, has a model RECOMMEND per area, and
// then parks the run so a human decides. That is why the plan and the review are two shapes
// rather than one: the plan is what the model proposed and what it read to propose it, the
// review is what the human settled, and both are kept so the applied result is attributable.
//
// The rules over these shapes are in kernel's `monorepo-adoption.logic.ts`; the SPA reads
// this module directly, which is why it lives in contracts rather than there (a human picks
// the choice, so both sides must agree about the vocabulary).
// ---------------------------------------------------------------------------

const shortText = v.pipe(v.string(), v.maxLength(600))
const pathText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400))

/**
 * The convention areas a bootstrap decides between the monorepo and the template.
 *
 * CLOSED and deliberately coarse: an area exists when a human would reasonably answer it
 * differently from its neighbours. Every member is also PERSISTED on a stored plan, so a
 * retired member survives in old rows: readers narrow through `isAdoptionArea` rather than
 * assuming the stored value is current (see kernel's `describeAdoptionArea`).
 */
export const adoptionAreaSchema = v.picklist([
  'build-tooling',
  'dependencies',
  'lint-format',
  'typecheck',
  'testing',
  'ci',
  'containerization',
  'runtime-config',
  'observability',
  'source-layout',
  'docs',
  'other',
])
export type AdoptionArea = v.InferOutput<typeof adoptionAreaSchema>

/**
 * Where one area's answer comes from.
 *
 * `both` is not a fudge: it is the real answer where the two sides are composable (the
 * monorepo's shared lint config EXTENDED by a template rule the new service needs).
 * `neither` is the equally real answer where the template ships something the monorepo has
 * no counterpart for and the new service does not need it. Dropping it is a decision, and
 * one a human should make deliberately rather than by the agent quietly not porting it.
 */
export const adoptionSourceSchema = v.picklist(['monorepo', 'template', 'both', 'neither'])
export type AdoptionSource = v.InferOutput<typeof adoptionSourceSchema>

/**
 * One reviewable line of the plan: what each side does about an area, what the model
 * recommends, and the repository paths it read to say so.
 *
 * `evidence` is not decoration. A recommendation with no path behind it is the model
 * asserting a monorepo convention it may have invented, and this is exactly the surface where
 * a human cannot check that by eye, so kernel drops a recommendation whose evidence names
 * nothing the survey actually read, and the plan records the drop.
 */
export const adoptionDecisionSchema = v.object({
  /** Stable within one plan; the id the human's choice refers back to. */
  id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  area: adoptionAreaSchema,
  /** One line naming the decision, e.g. "Test runner". */
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  /** What the rest of the monorepo does here; null when the survey found nothing. */
  monorepoPractice: v.nullable(shortText),
  /** What the template ships here; null when it ships nothing for this area. */
  templatePractice: v.nullable(shortText),
  /** The model's suggestion, which the human confirms or overrides. */
  recommended: adoptionSourceSchema,
  /** Why, in a sentence or two, naming the concrete thing that drove it. */
  rationale: shortText,
  /** Repository paths the recommendation was read from (`monorepo:`/`template:` prefixed). */
  evidence: v.array(pathText),
})
export type AdoptionDecision = v.InferOutput<typeof adoptionDecisionSchema>

/**
 * What the survey actually managed to read, reported beside the plan.
 *
 * "Absent" and "zero" must not render the same: a plan built without the monorepo's CI
 * workflows (unreadable, or simply not there) is a materially weaker plan than one built with
 * them, and only this section says which. `unreadable` therefore lists paths the survey TRIED
 * and failed on, distinct from paths it never looked for.
 */
export const adoptionSurveySchema = v.object({
  /** Monorepo paths read into the survey. */
  monorepoPaths: v.array(pathText),
  /** Reference-template paths read into the survey. */
  templatePaths: v.array(pathText),
  /** Paths the survey tried to read and could not (a provider failure, not an absence). */
  unreadablePaths: v.array(pathText),
  /**
   * The existing sibling service the survey used as the monorepo's worked example (the
   * directory it read a real service's own config from), or null when the target's parent
   * directory holds no sibling yet, in which case the survey saw the ROOT conventions only,
   * which is a materially thinner read and says so here rather than by omission.
   */
  siblingService: v.nullable(pathText),
})
export type AdoptionSurvey = v.InferOutput<typeof adoptionSurveySchema>

/**
 * Why a survey produced no plan. Distinct causes, because they need different fixes: an
 * unconfigured model is an operator action, an unreadable monorepo is a permissions problem,
 * and an unusable reply is a retry.
 */
export const adoptionPlanUnavailableReasonSchema = v.picklist([
  'model_unavailable',
  'repo_unreadable',
  'analysis_unusable',
])
export type AdoptionPlanUnavailableReason = v.InferOutput<
  typeof adoptionPlanUnavailableReasonSchema
>

/**
 * The suggestion a human reviews, or the stated reason there is none.
 *
 * A plan is `unavailable` rather than empty when the survey could not produce one: an empty
 * decision list and "the model was never reachable" are opposite facts, and a run that parked
 * on the second must say so, because the human is being asked to approve nothing.
 */
export const adoptionPlanSchema = v.object({
  status: v.picklist(['ready', 'unavailable']),
  /** Set when `status` is `unavailable`; null otherwise. */
  unavailableReason: v.nullable(adoptionPlanUnavailableReasonSchema),
  /** Human-readable detail behind `unavailableReason`; null when there was nothing to add. */
  unavailableDetail: v.nullable(shortText),
  survey: adoptionSurveySchema,
  decisions: v.array(adoptionDecisionSchema),
  /**
   * Recommendations the platform DROPPED because their evidence named nothing the survey
   * read. Reported rather than silently removed: a cap that hides what it dropped reads to a
   * reviewer exactly like a survey that found less.
   */
  droppedUnevidenced: v.array(v.pipe(v.string(), v.maxLength(200))),
  /** `provider:model` the plan was generated with; null when the plan is unavailable. */
  model: v.nullable(v.string()),
  generatedAt: v.number(),
})
export type AdoptionPlan = v.InferOutput<typeof adoptionPlanSchema>

/** The human's answer for one decision. */
export const adoptionChoiceSchema = v.object({
  /** The {@link AdoptionDecision.id} being answered. */
  id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  choice: adoptionSourceSchema,
  /** The reviewer's own instruction for this area, folded into the agent's brief verbatim. */
  note: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1000))),
})
export type AdoptionChoice = v.InferOutput<typeof adoptionChoiceSchema>

/**
 * The review body: one choice per decision, plus anything the reviewer wants to say about the
 * service as a whole.
 *
 * Every decision must be answered. A partial review is refused rather than defaulted to the
 * recommendation, because "I agree" and "I did not look at this one" are the two things this
 * whole step exists to tell apart.
 */
export const adoptionReviewSchema = v.object({
  choices: v.array(adoptionChoiceSchema),
  /** Extra instructions for the apply phase, appended to the run's brief. */
  notes: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type AdoptionReviewInput = v.InferOutput<typeof adoptionReviewSchema>

/** One settled decision: the plan's line plus what the human chose for it. */
export const resolvedAdoptionDecisionSchema = v.object({
  id: v.string(),
  area: adoptionAreaSchema,
  title: v.string(),
  /** What the human settled on. */
  choice: adoptionSourceSchema,
  /** Whether the human overrode the model's recommendation (kept for the track record). */
  overrodeRecommendation: v.boolean(),
  /** The reviewer's own instruction for this area; null when they left none. */
  note: v.nullable(v.string()),
})
export type ResolvedAdoptionDecision = v.InferOutput<typeof resolvedAdoptionDecisionSchema>

/** The review as stored on the run: what was settled, by whom, when. */
export const resolvedAdoptionSchema = v.object({
  decisions: v.array(resolvedAdoptionDecisionSchema),
  /** Free-form reviewer instructions for the whole service; null when none were given. */
  notes: v.nullable(v.string()),
  /** The reviewing user, when the request carried one; null for a headless approval. */
  reviewedByUserId: v.nullable(v.string()),
  reviewedAt: v.number(),
})
export type ResolvedAdoption = v.InferOutput<typeof resolvedAdoptionSchema>
