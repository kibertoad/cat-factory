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
 * - `dismissed`: waved off as not worth acting on.
 * All of `filed`/`queued`/`answered`/`dismissed` are "decided"; only `pending`
 * holds the gate.
 */
export const followUpItemStatusSchema = v.picklist([
  'pending',
  'filed',
  'queued',
  'answered',
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

/** Answer a `question` item (the answer is folded into the next Coder loop-back). */
export const answerFollowUpSchema = v.object({
  answer: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
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
