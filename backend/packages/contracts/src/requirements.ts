import * as v from 'valibot'
import { iterationCapChoiceSchema } from './iteration-cap.js'

// ---------------------------------------------------------------------------
// Requirements-review wire contracts. A reviewer agent inspects a board block's
// "collected requirements" — its description plus any linked PRD / RFC /
// requirements documents and tracker issues — and raises a list of review items:
// gaps, ambiguities, unstated assumptions, risks and open questions, each with a
// severity. A human answers or dismisses each item; an incorporation companion
// folds the answers into one standardized requirements document, then the reviewer
// re-reviews that document. The cycle repeats until the reviewer is clean (or every
// remaining finding is dismissed / tolerated by the task's severity threshold), or
// the task's iteration cap is hit and a human picks how to proceed.
//
// On the pipeline path the run parks on the requirements step while the human drives
// these round-trips; the run only advances (converge / proceed) or resets exactly
// once. The review + its items are persisted and mutated in plain request/response
// round-trips. Storage-only bookkeeping (the owning workspace) is NOT on the wire.
// ---------------------------------------------------------------------------

/** What kind of concern a review item raises. */
export const reviewItemCategorySchema = v.picklist([
  'gap',
  'clarification',
  'assumption',
  'risk',
  'question',
])
export type ReviewItemCategory = v.InferOutput<typeof reviewItemCategorySchema>

/** How important resolving the item is before implementation should proceed. */
export const reviewItemSeveritySchema = v.picklist(['low', 'medium', 'high'])
export type ReviewItemSeverity = v.InferOutput<typeof reviewItemSeveritySchema>

/**
 * Lifecycle of a single item: `open` until a human engages, `answered` once a
 * reply is recorded, `resolved` when accepted as done, `dismissed` when waved
 * off as not applicable, `recommend_requested` when the human asked the Requirement
 * Writer to suggest an answer instead of writing one. All of `answered`, `resolved`,
 * `dismissed` and `recommend_requested` count as "settled" (not `open`) for gating
 * incorporation — a finding awaiting a recommendation doesn't block the cycle, its
 * recommendation simply lands for review and folds into a later pass once accepted.
 */
export const reviewItemStatusSchema = v.picklist([
  'open',
  'answered',
  'resolved',
  'dismissed',
  'recommend_requested',
])
export type ReviewItemStatus = v.InferOutput<typeof reviewItemStatusSchema>

/** A single question / challenge the reviewer raised about the requirements. */
export const requirementReviewItemSchema = v.object({
  id: v.string(),
  category: reviewItemCategorySchema,
  severity: reviewItemSeveritySchema,
  /** Short headline of the concern. */
  title: v.string(),
  /** The full question / gap / challenge, in plain prose. */
  detail: v.string(),
  status: reviewItemStatusSchema,
  /** The human's answer, or null while unanswered. */
  reply: v.nullable(v.string()),
  /**
   * The reviewer's classification of whether this finding can be answered confidently from
   * universal engineering/product best practice or the context already provided (`true`), or
   * whether it needs a genuine business/product decision the reviewer can't make (`false`).
   * Drives the auto-recommendation automation (see {@link stepOptionsSchema.entries.autoRecommend}):
   * only `autoAnswerable` findings get a recommended default answer generated for them. Absent
   * on findings from a reviewer pass that predates the classification (treated as `false` — no
   * auto-answer, safest).
   */
  autoAnswerable: v.optional(v.boolean()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type RequirementReviewItem = v.InferOutput<typeof requirementReviewItemSchema>

/**
 * Lifecycle of the review as a whole:
 * - `ready`: the reviewer raised findings that are awaiting human answers/dismissals.
 * - `incorporating`: transient. The human answered the findings and asked to incorporate;
 *   the durable driver is folding the answers into a document (the FIRST async stage). No
 *   human action is needed — the user is back on the board.
 * - `reviewing`: transient. The document is folded and the reviewer is RE-reviewing it (the
 *   SECOND async stage). Distinguished from `incorporating` so the board/window can show
 *   which stage is running; the user is summoned again only if it yields `ready`/`exceeded`.
 * - `merged`: the companion produced an incorporated document (an internal transient on the
 *   async path — the driver re-reviews it immediately; only the off-path inline incorporate
 *   leaves a review here momentarily).
 * - `exceeded`: the iteration cap was reached with findings still open — awaiting the
 *   human's choice (one more round / proceed anyway / reset the task).
 * - `incorporated`: terminal. The requirements phase is settled; downstream agents
 *   consume {@link incorporatedRequirements} when present (else the original description).
 */
export const requirementReviewStatusSchema = v.picklist([
  'ready',
  'incorporating',
  'reviewing',
  'merged',
  'exceeded',
  'incorporated',
])
export type RequirementReviewStatus = v.InferOutput<typeof requirementReviewStatusSchema>

/**
 * Whether a review of ANY iterative subject (requirements / clarity / a brainstorm stage: one
 * lifecycle, one vocabulary) has STOPPED on a human.
 *
 * Exactly two statuses park. `ready` is the ordinary "findings are open, answer them"; `exceeded`
 * is the cap, where the human picks how to proceed rather than answering. Everything else is the
 * driver's own work: `incorporating` / `reviewing` / `merged` are transients it will leave on its
 * own, and `incorporated` has settled.
 *
 * Stated ONCE here because three layers ask it and each had started spelling it for itself: the
 * engine deciding whether a park is worth echoing onto a tracker issue, the tracker-reply path
 * deciding WHICH of a block's live reviews a bare control verb is about, and any surface
 * describing why a run stopped. The spellings had already drifted — a `!== 'incorporated'` test
 * counts a review the reviewer model is still running as one waiting for a person, which then
 * loses a tie-break to the review actually holding the run.
 *
 * Deliberately NOT the same question as "is this review still live" (`incorporating` IS live and
 * worth showing a poller); that one belongs to the surface doing the showing.
 */
export function reviewAwaitsHuman(status: RequirementReviewStatus): boolean {
  return status === 'ready' || status === 'exceeded'
}

/**
 * Lifecycle of a single Requirement-Writer recommendation:
 * - `pending`: a placeholder created the moment the human requested the recommendation;
 *   the Writer is still producing the suggestion in the durable driver (the async story —
 *   the human is back on the board, summoned by a notification when the batch finishes).
 *   The placeholder snapshots its source finding so progress (`ready / total`) survives the
 *   window closing; `recommendedText` is empty until the Writer fills it in.
 * - `ready`: the Writer produced a suggested answer; the human hasn't decided yet.
 * - `accepted`: the human took the suggestion — it becomes the source finding's answer
 *   and folds into the NEXT incorporation pass.
 * - `rejected`: the human declined it (they then dismiss / answer manually / re-request).
 */
export const recommendationStatusSchema = v.picklist(['pending', 'ready', 'accepted', 'rejected'])
export type RecommendationStatus = v.InferOutput<typeof recommendationStatusSchema>

/**
 * Where a Requirement-Writer suggestion actually came from — the Writer's own report of which
 * precedence level answered the finding:
 * - `standard`: a team/org best-practice standard settled it (`groundedInFragment` names which).
 * - `project-spec`: the project's committed `spec/`/`tech-spec/`.
 * - `web`: a web-search result.
 * - `general-practice`: the model's own general knowledge, with none of the above behind it.
 *
 * Surfaced because a suggestion that rests on nothing but the model looks exactly like one drawn
 * from the team's own standards once it is sitting in the answer box, and the two deserve very
 * different scrutiny. `groundedInFragment` already carried the strongest case; this makes the rest
 * legible instead of leaving "not from a standard" to cover everything from a cited source to a
 * guess. Null when the Writer did not report a level (an older row, or a garbled response).
 */
export const recommendationSourceSchema = v.picklist([
  'standard',
  'project-spec',
  'web',
  'general-practice',
])
export type RecommendationSource = v.InferOutput<typeof recommendationSourceSchema>

/**
 * The confidence floor an `unattended` run's auto-answer must clear, when the resolved risk policy
 * states none (`RiskPolicy.minAutoAnswerConfidence`).
 *
 * `0.8` rather than a lower number because of what the floor buys: below it the finding stays open
 * and the run parks, which costs a wait; above it the platform answers a question in the
 * requirements every later agent implements, with nobody reading it. The cheap failure is the one
 * to prefer.
 */
export const DEFAULT_MIN_AUTO_ANSWER_CONFIDENCE = 0.8

/**
 * The display bands a reported confidence falls into. A CLOSED vocabulary so every surface
 * showing a grade has an exhaustive set of keys to translate, rather than each inventing its own
 * cut-points and disagreeing about what "high" means.
 */
export const recommendationConfidenceBandSchema = v.picklist(['high', 'medium', 'low'])
export type RecommendationConfidenceBand = v.InferOutput<typeof recommendationConfidenceBandSchema>

/**
 * The band a Requirement-Writer confidence falls into, or `null` when the Writer reported none.
 *
 * `null` is a THIRD answer, never folded into `low`: "the model did not say" and "the model said it
 * is unsure" want different reactions from a reader, and only the second is evidence about the
 * suggestion. Both are below any floor above 0, so the automation treats them alike; a person
 * reading the window does not have to.
 */
export function recommendationConfidenceBand(
  confidence: number | null | undefined,
): RecommendationConfidenceBand | null {
  if (confidence == null) return null
  if (confidence >= 0.8) return 'high'
  return confidence >= 0.5 ? 'medium' : 'low'
}

/**
 * Whether a Writer recommendation is confident enough for an unattended run to take it as the
 * finding's answer and carry on with no person.
 *
 * An UNREPORTED confidence clears only a floor of `0`, which is the point: a garbled or older
 * Writer reply must not read as a confident one, and an operator who set no floor at all asked for
 * exactly the ungraded behaviour.
 */
export function clearsAutoAnswerFloor(
  confidence: number | null | undefined,
  floor: number,
): boolean {
  return confidence == null ? floor <= 0 : confidence >= floor
}

/**
 * A Requirement-Writer suggestion for one finding. Recommendations are a first-class
 * collection on the review (NOT on items) so they survive the item churn each re-review
 * causes — the source finding is snapshotted by title/detail rather than referenced by a
 * (volatile) item id. The Writer grounds the suggestion on the project's best-practice
 * fragments first, then `spec/` + `tech-spec/`, then web search; when the answer comes
 * straight from a best-practice fragment, {@link groundedInFragment} carries it so the UI
 * can mark the option as the current team/org standard. Recommendations are NOT AI-reviewed.
 */
export const requirementRecommendationSchema = v.object({
  id: v.string(),
  /**
   * Snapshot of the finding this recommends an answer for. `itemId` is the finding's id at
   * request time — the PRIMARY anchor, so two findings that happen to share an identical
   * title+detail stay distinct. Item ids churn across re-reviews, so matching falls back to
   * title+detail when the snapshotted id is no longer present (`itemId` is optional for that
   * reason and absent on pre-existing rows).
   */
  sourceFinding: v.object({
    title: v.string(),
    detail: v.string(),
    itemId: v.optional(v.string()),
  }),
  /** The suggested answer text. */
  recommendedText: v.string(),
  /**
   * True when this recommendation was generated AUTOMATICALLY (the auto-recommendation
   * automation) rather than requested by a human. An auto recommendation is auto-accepted the
   * moment it is produced — it becomes the finding's default answer (the finding flips to
   * `answered`) instead of parking in `ready` for a manual accept/reject — and the UI badges it
   * as an editable/dismissable recommended default. Absent/false ⇒ a human-requested
   * recommendation (the original flow). See {@link stepOptionsSchema.entries.autoRecommend}.
   */
  auto: v.optional(v.boolean()),
  status: recommendationStatusSchema,
  /** A "do it differently" note the human attached when re-requesting, else null. */
  note: v.nullable(v.string()),
  /**
   * Set when the recommendation is taken directly from a best-practice fragment (the
   * "current standard" signal), else null. Carries the fragment's id + title for the badge.
   */
  groundedInFragment: v.nullable(v.object({ id: v.string(), title: v.string() })),
  /**
   * Which precedence level the Writer reports the answer came from (see
   * {@link recommendationSourceSchema}). Optional so a row written before it existed still parses;
   * absent/null reads as "not reported", never as `general-practice` — an unreported source is not
   * evidence of a weak one.
   */
  groundedIn: v.optional(v.nullable(recommendationSourceSchema)),
  /**
   * How confident the Writer reports being in this suggestion (0..1), or null when it reported
   * nothing (an older row, a garbled response).
   *
   * SEPARATE from {@link groundedIn}, which says where the answer came from: a `project-spec`
   * answer can rest on a spec paragraph that only half addresses the question, and a
   * `general-practice` one can be near-certain because the practice is universal. Provenance tells
   * a reader how much to trust the SOURCE; this is the Writer's own claim about the ANSWER, and
   * the unattended auto-answer floor compares against it (see
   * `RiskPolicy.minAutoAnswerConfidence`).
   *
   * Null rather than a default, for the reason `groundedIn` is: an unreported grade is not
   * evidence of a low one, and pretending otherwise would put a number the model never gave in
   * front of the person deciding whether to keep the answer.
   */
  confidence: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1)))),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type RequirementRecommendation = v.InferOutput<typeof requirementRecommendationSchema>

/**
 * Whether every finding on this review is settled well enough for a run NOBODY IS WATCHING to fold
 * the answers in and carry on with no person.
 *
 * Three ways a finding can qualify, and the third is the only new one:
 *
 *   - it was dismissed or resolved;
 *   - it was ANSWERED by something a person wrote (in the app, over `/api/v1`, or on the ticket);
 *   - it was answered by an AUTO recommendation whose reported confidence clears `floor`, which is
 *     only ever the group the reviewer itself judged answerable without a product owner.
 *
 * Anything else — an open finding, one awaiting a recommendation, one auto-answered at or below the
 * floor — means a person is still needed, and the run parks exactly as it always did. ADR 0053 put
 * it as the rule this function has to keep: inventing a product judgement is the one thing an
 * unattended policy may never do. The narrowing that makes this compatible with it is that the
 * reviewer sorted its own findings into two groups first, and this only ever looks at one of them.
 *
 * Stated in contracts rather than in the engine because the review window shows the same verdict:
 * a person looking at a parked review needs to see WHICH finding is holding it, and a second
 * reading of "settled enough" would answer that differently from the engine that parked it.
 */
export function reviewSettledForUnattended(
  review: {
    items: readonly Pick<RequirementReviewItem, 'id' | 'status'>[]
    /**
     * Absent on a review kind that has no Writer (the clarity gate), which needs no special case:
     * with nothing auto-answered, every finding is either open (so the run parks, exactly as a
     * reporter's unanswered question should) or answered by the person who replied.
     */
    recommendations?: readonly Pick<
      RequirementRecommendation,
      'auto' | 'status' | 'sourceFinding' | 'confidence'
    >[]
  },
  floor: number,
): boolean {
  const autoAnswers = new Map(
    (review.recommendations ?? [])
      .filter((rec) => rec.auto === true && rec.status === 'accepted' && rec.sourceFinding.itemId)
      .map((rec) => [rec.sourceFinding.itemId as string, rec]),
  )
  return review.items.every((item) => {
    if (item.status === 'dismissed' || item.status === 'resolved') return true
    if (item.status !== 'answered') return false
    const auto = autoAnswers.get(item.id)
    return auto ? clearsAutoAnswerFloor(auto.confidence, floor) : true
  })
}

/** A completed requirements review for one board block. */
export const requirementReviewSchema = v.object({
  id: v.string(),
  blockId: v.string(),
  status: requirementReviewStatusSchema,
  items: v.array(requirementReviewItemSchema),
  /** `provider:model` that produced the review, for transparency; null in tests. */
  model: v.nullable(v.string()),
  /**
   * The revised requirements text the incorporation companion last folded the answers
   * into. Set once a doc has been produced (status `merged`/`incorporated`); null while
   * still awaiting answers on the first pass. Consumed by every downstream agent step +
   * the spec-writer once the phase is settled.
   */
  incorporatedRequirements: v.nullable(v.string()),
  /**
   * How many reviewer passes have run so far (the initial review is iteration 1; each
   * re-review adds one). Compared against {@link maxIterations} to decide when the loop
   * has exhausted its budget.
   */
  iteration: v.optional(v.number(), 1),
  /**
   * The reviewer-pass budget for this review, snapshotted from the task's merge preset
   * (`maxRequirementIterations`) when the review started. An "extra round" choice bumps
   * it by one.
   */
  maxIterations: v.optional(v.number(), 1),
  /**
   * Requirement-Writer suggestions awaiting (or settled by) human accept/reject. Survives
   * the re-review item churn — see {@link requirementRecommendationSchema}. Empty by default.
   */
  recommendations: v.optional(v.array(requirementRecommendationSchema), []),
  /**
   * Monotonic optimistic-concurrency token, bumped by the store on every persisted write.
   * A review is one JSON blob whose items/recommendations several writers touch at once (two
   * people answering different findings; a human dismissing one while the durable driver's
   * incorporation pass writes back), so a blind whole-row write silently drops the loser's
   * edit. Every mutation instead re-reads, re-applies and `compareAndSwap`s on this value, and
   * a lost race reloads rather than clobbers. Absent (a row written before the column existed)
   * reads as 0.
   */
  rev: v.optional(v.number(), 0),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type RequirementReview = v.InferOutput<typeof requirementReviewSchema>

// ---- Request bodies -------------------------------------------------------

/** Record a human's answer to a single review item. */
export const replyReviewItemSchema = v.object({
  reply: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type ReplyReviewItemInput = v.InferOutput<typeof replyReviewItemSchema>

/** Set a review item's status (resolve / dismiss / reopen). */
export const updateReviewItemStatusSchema = v.object({
  status: reviewItemStatusSchema,
})
export type UpdateReviewItemStatusInput = v.InferOutput<typeof updateReviewItemStatusSchema>

/**
 * Incorporate the settled answers into a standardized requirements document. An optional
 * `feedback` comment is the human's "do it differently" lever when redoing a merge they
 * were unhappy with — it is folded into the rework prompt alongside the prior document.
 */
export const incorporateRequirementsSchema = v.object({
  feedback: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type IncorporateRequirementsInput = v.InferOutput<typeof incorporateRequirementsSchema>

/**
 * One finding the human asked the Requirement Writer to recommend an answer for, with OPTIONAL
 * per-finding guidance. `note` is transformed from whatever the human typed into that finding's
 * answer box before choosing "recommend something": it STEERS the suggestion for THIS finding
 * ("prefer the existing library", a rough direction) rather than being the answer itself. Absent
 * when the human asked for a recommendation without typing any direction.
 */
export const requestRecommendationItemSchema = v.object({
  itemId: v.string(),
  note: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type RequestRecommendationItem = v.InferOutput<typeof requestRecommendationItemSchema>

/**
 * Ask the Requirement Writer to recommend answers for a batch of findings. Sent when the human
 * marks findings "recommend something" instead of answering them. Each entry carries its finding
 * id plus OPTIONAL per-finding guidance (see {@link requestRecommendationItemSchema}), so two
 * findings in the same batch can steer the Writer differently. The Writer runs ASYNCHRONOUSLY in
 * the durable driver: the call returns at once with `pending` placeholder recommendations, which
 * fill in (`ready`) one by one and raise a notification when the batch finishes.
 */
export const requestRecommendationsSchema = v.object({
  items: v.pipe(v.array(requestRecommendationItemSchema), v.minLength(1)),
})
export type RequestRecommendationsInput = v.InferOutput<typeof requestRecommendationsSchema>

/**
 * Re-request a single recommendation with a "do it differently" note (the human rejected
 * the first suggestion but wants another grounded attempt rather than answering manually).
 */
export const reRequestRecommendationSchema = v.object({
  note: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type ReRequestRecommendationInput = v.InferOutput<typeof reRequestRecommendationSchema>

/**
 * How a human resolves a requirements review that hit its iteration cap with findings
 * still open: `extra-round` grants one more reviewer pass, `proceed` advances the
 * pipeline using the last incorporated document, `stop-reset` cancels the run and
 * returns the task to phase zero (editable) while keeping the last incorporated doc.
 * Shares the {@link iterationCapChoiceSchema} with the companion gate — same three
 * choices, one source of truth (see `./iteration-cap.ts`).
 */
export const resolveRequirementsExceededSchema = v.object({
  choice: iterationCapChoiceSchema,
})
export type ResolveRequirementsExceededInput = v.InferOutput<
  typeof resolveRequirementsExceededSchema
>
export type ResolveRequirementsExceededChoice = ResolveRequirementsExceededInput['choice']

// NOTE: the durable, in-repo PRESCRIPTIVE specification (the `spec.json` tree with its
// requirements, domain rules and acceptance criteria) lives in `./spec.ts`. This file
// is only the transient, per-block CONTEXT review of the linked-prose brief.
