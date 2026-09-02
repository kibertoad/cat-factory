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

/**
 * The longest a transcript key or an evidence citation may be.
 *
 * Exported because the producer has to respect it rather than discover it: a transcript key is
 * the raw repository path PREFIXED with its side (and suffixed with `/` for a listing), so the
 * survey caps what it accepts by deriving from this instead of restating 400 and quietly
 * emitting a row the contract says is too long.
 */
export const MAX_ADOPTION_READ_PATH = 400

const pathText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_ADOPTION_READ_PATH))

/**
 * How many drop lines one plan may carry, plus one slot for the "and N more" summary.
 *
 * Lives here rather than in kernel's logic because it bounds what a ROW may hold and kernel's
 * parser is what has to respect it, so the parser imports this instead of restating it. Stated at
 * all because the previous shape capped each LINE and not the array: a reply whose every entry is
 * invalid contributes one line each and never trips the decision cap, so the wall the decision cap
 * exists to prevent arrived through the drop list instead.
 */
export const MAX_ADOPTION_DROP_LINES = 24

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
 * How many reads one survey's transcript may record.
 *
 * The exploration budget bounds what the MODEL may ask for, but a single model turn can emit any
 * number of tool calls, and a call refused for a bad path is still a call. So the transcript has
 * a cap of its own, and what the cap CUT rides on `AdoptionExploration.recordsDropped`: the gap
 * between `calls` and `reads.length` cannot state it, since the seed's own reads add rows without
 * adding calls and a call answered from what was already read adds a call without a row.
 */
export const MAX_ADOPTION_READS = 96

/** Who asked for one read: the platform's opening context, or the model itself. */
export const adoptionReadOriginSchema = v.picklist(['seed', 'model'])
export type AdoptionReadOrigin = v.InferOutput<typeof adoptionReadOriginSchema>

/**
 * What one read produced. Four outcomes, because they send a reader to four different places.
 *
 * `absent` is the repository answering "there is no such file", which is EVIDENCE. `unreadable`
 * is the provider failing (a revoked token, a rate limit, an outage), which is the absence of
 * evidence and must never render as the first. `refused` is the PLATFORM declining: an exhausted
 * budget or a path it will not fetch, which is a ceiling to raise rather than anything about the
 * repository at all.
 */
export const adoptionReadOutcomeSchema = v.picklist(['read', 'absent', 'unreadable', 'refused'])
export type AdoptionReadOutcome = v.InferOutput<typeof adoptionReadOutcomeSchema>

/**
 * One read the survey performed, in the order it happened.
 *
 * The transcript is the survey: what the plan carries is what was actually fetched, not a list
 * the platform predicted it would need. That is what makes the evidence check upstream
 * (`parseAdoptionDecisions`) meaningful rather than circular, because a citation is checked
 * against a record of reads that already happened.
 */
export const adoptionReadSchema = v.object({
  /**
   * The `monorepo:`/`template:`-prefixed path, exactly the key a decision's `evidence` cites. A
   * trailing `/` marks a directory LISTING rather than a file, so a reader can tell the two apart
   * without a second field.
   */
  path: pathText,
  origin: adoptionReadOriginSchema,
  outcome: adoptionReadOutcomeSchema,
  /** Characters this read contributed to the content budget; 0 when it produced nothing. */
  chars: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Why a read was refused or failed; null when it succeeded. */
  note: v.nullable(shortText),
})
export type AdoptionRead = v.InferOutput<typeof adoptionReadSchema>

/**
 * What the survey's bounded exploration spent, and whether it ran out.
 *
 * `exhausted` is the load-bearing field. A survey that stopped because the model had seen enough
 * and one that stopped because it hit a ceiling produce the same-looking transcript, and only the
 * second means the plan is missing areas nobody decided not to look at. It is reported to the
 * model DURING the loop (so the recommendations can say which areas ran short) and to the human
 * reviewer beside the plan.
 */
export const adoptionExplorationSchema = v.object({
  /** Every read the MODEL asked for: refused ones and re-requests of a known file included. */
  calls: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxCalls: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Characters the model's OWN reads spent. The seed's spend is not folded in: it answers to a
   * separate per-side reservation, and one number over two budgets could not say which ran out.
   * What the seed spent is on the transcript, per read.
   */
  chars: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxChars: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Which budget ran out, or null when the loop ended with room to spare. */
  exhausted: v.nullable(v.picklist(['calls', 'chars'])),
  /**
   * Reads the transcript could not hold, because `reads` is capped at
   * {@link MAX_ADOPTION_READS}.
   *
   * Carried as its own number rather than left to be inferred from a length, because the only
   * surface that renders the transcript summarises the ARRAY: a survey that recorded 140 reads
   * and kept 96 would otherwise read to a reviewer as a survey that made 96, which is the
   * "absent and zero must not render the same" failure this whole shape exists to avoid.
   */
  recordsDropped: v.pipe(v.number(), v.integer(), v.minValue(0)),
})
export type AdoptionExploration = v.InferOutput<typeof adoptionExplorationSchema>

/**
 * What the survey actually read, reported beside the plan.
 *
 * "Absent" and "zero" must not render the same: a plan built without the monorepo's CI workflows
 * (unreadable, or simply not there) is a materially weaker plan than one built with them, and
 * only this section says which. The transcript therefore records the reads that FAILED and the
 * ones the platform REFUSED beside the ones that succeeded, and `exploration` says whether the
 * read stopped because there was nothing left worth fetching or because a ceiling was hit.
 */
export const adoptionSurveySchema = v.object({
  /**
   * Every read, in order, or `null` where the projection did not carry the transcript at all.
   *
   * Bounded by {@link MAX_ADOPTION_READS}, with `exploration.recordsDropped` stating what the cap
   * cut, so a truncated transcript states itself rather than reading as a shorter survey.
   *
   * NULLABLE for the same reason, one level up. The transcript is reviewer detail: the only
   * surface that renders it is the review a parked run waits on, while the LIST projection that
   * feeds every workspace snapshot carries every bootstrap run the workspace has ever made,
   * forever. So the list withholds it once the run is past review, and says so HERE rather than
   * sending `[]`, which is the shape of a survey that read nothing.
   */
  reads: v.nullable(v.pipe(v.array(adoptionReadSchema), v.maxLength(MAX_ADOPTION_READS))),
  /**
   * The existing sibling services the survey offered as worked examples: directories beside the
   * new one that hold a convention file of their own.
   *
   * A LIST rather than one pick, because one sibling is a sample of size one. A monorepo with a
   * six-year-old Java service beside three new TypeScript ones has no single house convention,
   * and a survey that names whichever directory it probed first reports a disagreement as though
   * it were the answer. Empty means nothing beside the target qualified, so the survey saw the
   * ROOT conventions only, which is a materially thinner read and says so here rather than by
   * omission.
   */
  siblingServices: v.array(pathText),
  exploration: adoptionExplorationSchema,
})
export type AdoptionSurvey = v.InferOutput<typeof adoptionSurveySchema>

/**
 * Why a survey produced no plan. Distinct causes, because they need different fixes: an
 * unconfigured model is an operator action, an unreadable monorepo is a permissions problem, an
 * exhausted budget is a ceiling to raise or a window to wait out, and an unusable reply is a
 * retry. Collapsing any pair of them would send someone to fix a build with nothing wrong in it.
 */
export const adoptionPlanUnavailableReasonSchema = v.picklist([
  'model_unavailable',
  'repo_unreadable',
  'budget_exhausted',
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
   *
   * Bounded in BOTH dimensions: kernel's parser reports the first {@link MAX_ADOPTION_DROP_LINES}
   * and COUNTS the rest into one closing line, reading the cap from here so the parser and the
   * schema cannot disagree about it.
   */
  droppedUnevidenced: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(200))),
    v.maxLength(MAX_ADOPTION_DROP_LINES + 1),
  ),
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
