import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Follow-up companion wire contracts. As the Coder works it surfaces forward-
// looking items over a live side channel (the harness streams them out of the
// running container, see the executor-harness): genuine loose ends / useful
// follow-ups / side-tasks it noticed but deliberately did NOT act on
// (`kind: 'follow_up'`), and clarifying QUESTIONS it would otherwise have to
// guess at (`kind: 'question'`). The "Follow-up companion" — a blinking chip on
// the Coder step — lights up the instant the first item appears, while the Coder
// is still running, and a human triages each item:
//   - a follow-up can be FILED as a tracker issue, QUEUED to send back to the
//     Coder (the pipeline loops back to the Coder for another pass), or DISMISSED;
//   - a question is ANSWERED (the answer is folded into the next Coder loop-back —
//     the live container can't be answered in place) or DISMISSED.
// The pipeline's following steps do not start until every item is decided: an
// undecided follow-up or an unanswered question is a `pending` blocker the
// engine parks the run on at Coder completion. State lives on the run's Coder
// step (`PipelineStep.followUps`), not a dedicated table — it is run-scoped and
// rides the execution stream, so it is runtime-symmetric by construction.
// ---------------------------------------------------------------------------

/**
 * What a surfaced item is: a forward-looking `follow_up` (a loose end / side-task
 * the Coder noticed but did not act on) or a `question` (a clarification the Coder
 * raised mid-run). The kind drives which actions the triage window offers and how
 * the completion gate treats the item.
 */
export const followUpItemKindSchema = v.picklist(['follow_up', 'question'])
export type FollowUpItemKind = v.InferOutput<typeof followUpItemKindSchema>

/**
 * Lifecycle of a single item:
 * - `pending`: surfaced, awaiting a human decision. An undecided follow-up OR an
 *   unanswered question — either blocks the pipeline at Coder completion.
 * - `filed`: a follow-up filed as a tracker issue (`ticketExternalId`/`ticketUrl` set).
 * - `queued`: a follow-up the human sent back to the Coder; folded into the next
 *   Coder loop-back as rework.
 * - `answered`: a question the human answered (`answer` set); the Q&A is folded into
 *   the next Coder loop-back.
 * - `closed`: a question RULED ON without a loop-back (`answer` carries the reason).
 *   Nobody could supply what the Coder asked for, or the ask was settled by what the
 *   brief already says, so there is nothing for another pass to apply. See
 *   {@link followUpResolutionSchema} for why this is a status of its own.
 * - `dismissed`: waved off as not worth acting on.
 * All of `filed`/`queued`/`answered`/`closed`/`dismissed` are "decided"; only `pending`
 * holds the gate.
 */
export const followUpItemStatusSchema = v.picklist([
  'pending',
  'filed',
  'queued',
  'answered',
  'closed',
  'dismissed',
])
export type FollowUpItemStatus = v.InferOutput<typeof followUpItemStatusSchema>

/** A single forward-looking item the Coder surfaced. */
export const followUpItemSchema = v.object({
  id: v.string(),
  kind: followUpItemKindSchema,
  /** Short headline of the loose end / question. */
  title: v.string(),
  /** The full detail, in plain prose. */
  detail: v.string(),
  /** An optional concrete suggestion the Coder offered (a follow-up's proposed fix). */
  suggestedAction: v.optional(v.nullable(v.string())),
  status: followUpItemStatusSchema,
  /** The human's answer to a `question` item, or null while unanswered / not a question. */
  answer: v.optional(v.nullable(v.string())),
  /**
   * True once a `queued` follow-up / `answered` question has been folded into a Coder
   * loop-back, so the next Coder completion does not send it back again. Absent until sent.
   */
  sentToCoder: v.optional(v.boolean()),
  /**
   * True when this item was `dismissed` by the run's risk policy rather than by a person
   * (`autonomy: 'unattended'`, on a run nothing was watching). Absent on every human decision.
   *
   * Recorded because the two dismissals mean opposite things to whoever reads the step later: one
   * is somebody deciding the loose end is not worth acting on, the other is nobody having looked
   * at it. Collapsing them would turn the item list of an unattended run into a claim that every
   * follow-up was triaged.
   */
  dismissedByPolicy: v.optional(v.boolean()),
  /**
   * True when this item was decided for a send-back (`queued` / `answered`) that the step's loop
   * budget could not pay for: `loops` had already reached `maxLoops`, so the Coder never received
   * it. Absent on every item that was sent, and on every item that was never going to be.
   *
   * The sibling of {@link dismissedByPolicy}, and recorded for the same reason. Without it a
   * dropped send-back is stored as `answered` with `sentToCoder` false forever, which is
   * indistinguishable from an answer still queued for a pass that is about to run, and reads to
   * anybody auditing the step as an answer the Coder acted on. A budget that quietly discards a
   * human's decision has to say so.
   */
  sendBackDropped: v.optional(v.boolean()),
  /** Canonical external id of the filed ticket (e.g. "owner/repo#123"), when `filed`. */
  ticketExternalId: v.optional(v.nullable(v.string())),
  /** URL of the filed ticket, when `filed`. */
  ticketUrl: v.optional(v.nullable(v.string())),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type FollowUpItem = v.InferOutput<typeof followUpItemSchema>

/**
 * Live follow-up companion state carried on the run's Coder step. Set when the
 * Coder step has the companion enabled (copied from the pipeline's per-step
 * `followUps` toggle at run start). `items` accrue live as the harness streams
 * them; `loops` counts how many times the Coder has been looped back for queued
 * items / answered questions, bounded by `maxLoops`.
 */
export const followUpsStepStateSchema = v.object({
  /** Whether the companion is active on this step (the per-step builder toggle). */
  enabled: v.boolean(),
  /** The surfaced items, in arrival order. Empty until the Coder surfaces the first one. */
  items: v.array(followUpItemSchema),
  /** Send-back loops performed so far (a queued follow-up / answered question re-runs the Coder). */
  loops: v.optional(v.number(), 0),
  /** The send-back loop budget; once `loops` reaches it, queued/answered items advance without re-running. */
  maxLoops: v.optional(v.number(), 3),
})
export type FollowUpsStepState = v.InferOutput<typeof followUpsStepStateSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * What answering a `question` DOES, which is not the same as what the answer says.
 *
 * - `answered` (the default, and every answer before this existed): the reply carries information
 *   the next pass applies, so it is folded into a Coder loop-back.
 * - `closed`: the reply RULES ON the question without supplying anything to act on. The Coder
 *   asked for a fact nobody here has, or asked to widen scope and the answer is no. The reason is
 *   still recorded in `answer` and still shown to the Coder, as something already settled.
 *
 * Split from the answer TEXT because the engine cannot read the difference out of prose, and
 * guessing it wrong is expensive in both directions. Answering every question as if it carried new
 * information is what produced the loop this vocabulary exists to end: a question the answerer
 * could not resolve ("which IngressClass does the target cluster mark as default?") came back with
 * a generic steer, the Coder found nothing in it to apply, reworded the surrounding comment, and
 * re-raised the same question under a new title. Three passes, one commit's worth of change, and
 * the budget rather than the conversation was what finally stopped it.
 *
 * The answerer always knows which one they are giving. Ask them rather than infer it.
 */
export const followUpResolutionSchema = v.picklist(['answered', 'closed'])
export type FollowUpResolution = v.InferOutput<typeof followUpResolutionSchema>

/**
 * Answer a `question` item. `answered` folds the answer into the next Coder loop-back;
 * `closed` records it as a ruling with no further pass. See {@link followUpResolutionSchema}.
 *
 * `resolution` is OPTIONAL and an omitted one means `answered`, so a caller written before it
 * existed keeps its exact prior behaviour. That is the public surface's additive rule
 * (`backend/docs/public-api.md`), and it is also the right reading on the merits: an answer that
 * came with no disposition is one somebody typed into a box that promised to send it back.
 *
 * Declared WITHOUT a valibot `default`, deliberately. A schema default is "always present on the
 * way out, optional on the way in", and the SDK emitters cannot render one shape as both
 * (`scripts/sdk/ir.mjs` refuses it rather than guessing). So the field is plainly optional on the
 * wire and the ENGINE owns the fallback, in `FollowUpGateController.answerFollowUp`, which is the
 * one place that has to agree with itself about what an absent disposition means.
 */
export const answerFollowUpSchema = v.object({
  answer: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
  resolution: v.optional(followUpResolutionSchema),
})
export type AnswerFollowUpInput = v.InferOutput<typeof answerFollowUpSchema>

/**
 * One streamed item line the harness lifts off the Coder container's sentinel file
 * (`.cat-follow-ups.jsonl`). The coder writes lenient lines (title/detail + kind);
 * the engine assigns the id/status/timestamps when it records them onto the step,
 * so this is the minimal shape the harness forwards.
 */
export const streamedFollowUpSchema = v.object({
  kind: v.optional(followUpItemKindSchema, 'follow_up'),
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
  detail: v.optional(v.string(), ''),
  suggestedAction: v.optional(v.nullable(v.string())),
})
export type StreamedFollowUp = v.InferOutput<typeof streamedFollowUpSchema>
