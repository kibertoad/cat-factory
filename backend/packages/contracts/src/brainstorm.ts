import * as v from 'valibot'
import { iterationCapChoiceSchema } from './iteration-cap.js'
import { requirementReviewItemSchema, requirementReviewStatusSchema } from './requirements.js'

// ---------------------------------------------------------------------------
// Brainstorm wire contracts. A brainstorm agent runs a STRUCTURED DIALOGUE to
// help a human arrive at a solution from a rough, vague seed — the inverse of an
// agent that does all the work itself. It proposes a handful of concrete OPTIONS
// (each with explicitly identified trade-offs) as "findings", the human picks /
// steers / dismisses them, an incorporation companion folds the picks into ONE
// converged direction document, and the agent re-runs against that direction
// until the human is satisfied (or the iteration cap is hit).
//
// There are two stages, served by ONE engine:
//   - `requirements` — seeded by the raw/vague task description; converges on a
//     crisp requirements direction (feeds the downstream requirements review).
//   - `architecture` — seeded by the requirements refined in prior stages;
//     converges on a finalized approach (feeds the downstream architect).
//
// This is the requirements-review iterative loop applied to a GENERATIVE subject,
// so it REUSES the requirements review item + status shapes (one source of truth)
// and differs only in the subject, the `stage` discriminator and the persisted
// document field (`convergedDirection`). A block may have one live session per
// stage at once, so a session is keyed by (block, stage), not block alone.
// ---------------------------------------------------------------------------

/** Which dialogue a brainstorm session drives. */
export const brainstormStageSchema = v.picklist(['requirements', 'architecture'])
export type BrainstormStage = v.InferOutput<typeof brainstormStageSchema>

/** A single proposed option / idea the agent raised — same shape as a requirements item. */
export const brainstormItemSchema = requirementReviewItemSchema
export type BrainstormItem = v.InferOutput<typeof brainstormItemSchema>

/** Lifecycle of a brainstorm session as a whole — identical to the requirements review lifecycle. */
export const brainstormStatusSchema = requirementReviewStatusSchema
export type BrainstormStatus = v.InferOutput<typeof brainstormStatusSchema>

/** A brainstorm dialogue session for one board block and one stage. */
export const brainstormSessionSchema = v.object({
  id: v.string(),
  blockId: v.string(),
  /** Which dialogue this session drives (a block may have one live session per stage). */
  stage: brainstormStageSchema,
  status: brainstormStatusSchema,
  items: v.array(brainstormItemSchema),
  /** `provider:model` that produced the options, for transparency; null in tests. */
  model: v.nullable(v.string()),
  /**
   * The converged direction the incorporation companion last folded the human's picks into.
   * Set once a doc has been produced (status `merged`/`incorporated`); null while still
   * awaiting picks on the first pass. Consumed by the downstream stage (`requirements` →
   * the requirements review, `architecture` → the architect) once the dialogue is settled.
   */
  convergedDirection: v.nullable(v.string()),
  /** How many agent passes have run so far (the initial pass is iteration 1). */
  iteration: v.optional(v.number(), 1),
  /** The agent-pass budget, snapshotted from the task's merge preset when the session started. */
  maxIterations: v.optional(v.number(), 1),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type BrainstormSession = v.InferOutput<typeof brainstormSessionSchema>

// ---- Request bodies -------------------------------------------------------

/** Record a human's response to a single brainstorm option (pick / steer). */
export const replyBrainstormItemSchema = v.object({
  reply: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type ReplyBrainstormItemInput = v.InferOutput<typeof replyBrainstormItemSchema>

/** Set a brainstorm option's status (resolve / dismiss / reopen). */
export const updateBrainstormItemStatusSchema = v.object({
  status: v.picklist(['open', 'answered', 'resolved', 'dismissed']),
})
export type UpdateBrainstormItemStatusInput = v.InferOutput<typeof updateBrainstormItemStatusSchema>

/**
 * Incorporate the human's picks into one converged direction document. An optional
 * `feedback` comment is the human's "do it differently" lever when redoing a merge.
 */
export const incorporateBrainstormSchema = v.object({
  feedback: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type IncorporateBrainstormInput = v.InferOutput<typeof incorporateBrainstormSchema>

/** How a human resolves a brainstorm session that hit its iteration cap with options open. */
export const resolveBrainstormExceededSchema = v.object({
  choice: iterationCapChoiceSchema,
})
export type ResolveBrainstormExceededInput = v.InferOutput<typeof resolveBrainstormExceededSchema>
export type ResolveBrainstormExceededChoice = ResolveBrainstormExceededInput['choice']
