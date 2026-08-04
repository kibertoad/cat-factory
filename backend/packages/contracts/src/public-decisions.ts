import * as v from 'valibot'
import { forkDecisionStatusSchema, forkOptionSchema } from './forkDecision.js'
import {
  inputGateIssueSchema,
  inputGateModeSchema,
  inputGateStatusSchema,
  resolveInputGateSchema,
} from './input-gate.js'
import { judgeStatusSchema, judgeVerdictSchema, resolveJudgeSchema } from './judge.js'
import { publicRunStatusSchema } from './public-api.js'
import {
  requirementReviewStatusSchema,
  reviewItemCategorySchema,
  reviewItemSeveritySchema,
  reviewItemStatusSchema,
} from './requirements.js'

// ---------------------------------------------------------------------------
// Public-API wire contracts for a run's PARKED HUMAN DECISIONS (`/api/v1/runs/:runId/decisions`).
//
// The requirements-review loop is the platform's clarification machinery: the reviewer raises
// findings, the run parks on a durable decision-wait, a human answers/dismisses, an incorporation
// pass folds the answers in, and the run advances. Until now that loop was reachable only through
// the SPA, so a headless (`/api/v1`) run could not include clarification at all — the public
// surface refused any pipeline that could park.
//
// These resources are the external counterpart of that loop. Four decision kinds are exposed
// today: the requirements review (findings + the iteration loop), the implementation-fork choice,
// a parked judge verdict, and the pre-dispatch input gate. Each is deliberately a SMALL projection of
// the internal entity, following the `publicTask` / `publicService` pattern: a caller sees the
// findings and their stable ids, never the engine's step/approval internals, the recommendation
// machinery, or the reviewer's model plumbing.
//
// Answering rides the SAME service methods the SPA controllers call, so the park's CAS/approval-id
// arbitration and the task's merge-preset knobs (iteration cap, tolerated severity) apply
// identically whichever surface answers first. See
// `docs/initiatives/headless-clarification-loop.md`.
// ---------------------------------------------------------------------------

/** Which parked decision a `publicDecision` entry describes. */
export const publicDecisionKindSchema = v.picklist([
  'requirements-review',
  'fork',
  'judge',
  'input-gate',
])
export type PublicDecisionKind = v.InferOutput<typeof publicDecisionKindSchema>

/**
 * One reviewer finding as exposed externally — the question, how serious it is, and where it
 * stands. `itemId` is the STABLE anchor a reply addresses (and, in slice 2, the id rendered into
 * the tracker-issue comment so a ticket reply can target a finding). The internal item's
 * `autoAnswerable` classification and the Requirement-Writer recommendation machinery are
 * deliberately not exposed: they drive in-app affordances a headless caller has no use for.
 */
export const publicReviewFindingSchema = v.object({
  itemId: v.string(),
  /** What kind of concern this raises (gap / clarification / assumption / risk / question). */
  category: reviewItemCategorySchema,
  /** How important resolving it is before implementation proceeds. */
  severity: reviewItemSeveritySchema,
  /** Short headline of the concern. */
  title: v.string(),
  /** The full question / gap / challenge, in plain prose. */
  detail: v.string(),
  /** `open` until answered or dismissed; only `open` findings block incorporation. */
  status: reviewItemStatusSchema,
  /** The recorded answer, or null while unanswered. */
  reply: v.nullable(v.string()),
})
export type PublicReviewFinding = v.InferOutput<typeof publicReviewFindingSchema>

/**
 * A parked requirements review as exposed externally. The loop a caller drives: answer or dismiss
 * every `open` finding, then `incorporate` (which folds the answers into one standard-format
 * document and re-reviews it in the background). The review converges (`incorporated` — the run
 * advances), comes back with a fresh round (`ready`), or hits its iteration cap (`exceeded`, where
 * `resolve-exceeded` picks one more round / proceed anyway / stop).
 */
export const publicRequirementsDecisionSchema = v.object({
  kind: v.literal('requirements-review'),
  reviewId: v.string(),
  /** The board task the review belongs to. */
  taskId: v.string(),
  status: requirementReviewStatusSchema,
  /** Which reviewer pass this is (the initial review is 1). */
  iteration: v.number(),
  /** The reviewer-pass budget, from the task's merge preset. */
  maxIterations: v.number(),
  findings: v.array(publicReviewFindingSchema),
  /**
   * The standardized requirements document the last incorporation produced; null until one
   * exists. Once the review settles, this is what every downstream agent implements — so a
   * caller can read exactly what its answers turned into before proceeding.
   */
  incorporatedRequirements: v.nullable(v.string()),
})
export type PublicRequirementsDecision = v.InferOutput<typeof publicRequirementsDecisionSchema>

/**
 * A parked implementation-fork choice as exposed externally: the materially different ways to
 * implement the task, surfaced before any code is written. A caller picks a `forkId` or submits
 * its own `custom` approach; the Coder then runs with the choice folded in as a binding directive.
 * The grounded chat is deliberately NOT exposed — it is an interactive deliberation affordance,
 * and a headless caller that wants to reason about the forks has the full `approach`/`tradeoffs`
 * text right here.
 */
export const publicForkDecisionSchema = v.object({
  kind: v.literal('fork'),
  /** The run's fork-decision lifecycle state; only `awaiting_choice` accepts a choice. */
  status: forkDecisionStatusSchema,
  /** The proposer's read of where the change lands (grounding for the choice). */
  seamSummary: v.nullable(v.string()),
  /** The proposed approaches, each with its id, plan, trade-offs and risk notes. */
  forks: v.array(forkOptionSchema),
})
export type PublicForkDecision = v.InferOutput<typeof publicForkDecisionSchema>

/**
 * A parked JUDGE verdict as exposed externally (the fourth step-taxonomy bucket): a rubric
 * scored the run's work below the task's threshold and the run stopped for a human. A caller
 * reads the score, the threshold it missed, and the findings behind it, then resolves it with
 * `proceed` / `bounce` / `stop` — the SAME service method the SPA's judge window calls.
 *
 * The rubric BODY is deliberately not exposed: it is deployment (or workspace) policy text, often
 * long, and a caller answering a verdict acts on the findings, not on the rubric that produced them.
 */
export const publicJudgeDecisionSchema = v.object({
  kind: v.literal('judge'),
  /** The judge step's kind (`agentKind`), which names WHICH judge is asking. */
  stepKind: v.string(),
  status: judgeStatusSchema,
  /** The rubric's stable id + human name, so a caller can tell two judges apart. */
  rubricId: v.nullable(v.string()),
  rubricName: v.nullable(v.string()),
  /** The score the verdict had to reach (from the task's merge preset). */
  threshold: v.nullable(v.number()),
  /** The latest verdict: score, summary and the findings behind it. */
  verdict: v.nullable(judgeVerdictSchema),
  /** Rework rounds spent and the ceiling, so a caller knows whether `bounce` is the last word. */
  bounces: v.number(),
  maxBounces: v.number(),
})
export type PublicJudgeDecision = v.InferOutput<typeof publicJudgeDecisionSchema>

/**
 * A run parked on the PRE-DISPATCH INPUT GATE as exposed externally: the task states nothing an
 * agent could act on, and the run stopped before its first dispatch having spent nothing.
 *
 * This one is exposed for a reason the other three do not have. The gate parks on the shape of
 * the TASK rather than the shape of the pipeline, so it can hold ANY public run, including one
 * whose pipeline carries no park at all; a caller filing title-only tasks would otherwise watch
 * them stop with `GET .../decisions` reporting `parked: true` and nothing to answer, and
 * `POST /api/v1/jobs/:id/cancel` as the only way out. The findings are the same closed codes the
 * SPA renders, so an integration can map them to its own copy or hand them back to whoever filed
 * the ticket.
 */
export const publicInputGateDecisionSchema = v.object({
  kind: v.literal('input-gate'),
  /** The disposition; only `blocked` accepts an answer. */
  status: inputGateStatusSchema,
  /** The workspace mode the evaluation ran under, so a verdict explains its own severities. */
  mode: inputGateModeSchema,
  /** Every finding, blocking and advisory alike, in a stable order. */
  issues: v.array(inputGateIssueSchema),
  /** Epoch ms of the evaluation that produced this verdict. */
  checkedAt: v.number(),
})
export type PublicInputGateDecision = v.InferOutput<typeof publicInputGateDecisionSchema>

export const publicDecisionSchema = v.variant('kind', [
  publicRequirementsDecisionSchema,
  publicForkDecisionSchema,
  publicJudgeDecisionSchema,
  publicInputGateDecisionSchema,
])
export type PublicDecision = v.InferOutput<typeof publicDecisionSchema>

/**
 * A run's currently-parked decisions. `parked` is the single flag a caller polls or reacts to:
 * true when the run is `blocked` awaiting one of the decisions listed. An empty list with
 * `parked: false` is the ordinary case for a run that is simply still working.
 */
export const publicDecisionListSchema = v.object({
  runId: v.string(),
  taskId: v.string(),
  /** The run's raw status — `blocked` is the parked state. */
  status: publicRunStatusSchema,
  /** Whether the run is currently parked awaiting a human decision. */
  parked: v.boolean(),
  decisions: v.array(publicDecisionSchema),
})
export type PublicDecisionList = v.InferOutput<typeof publicDecisionListSchema>

// ---- Request bodies -------------------------------------------------------

/** Answer one reviewer finding. Mirrors the SPA's `replyReviewItemSchema` bounds. */
export const publicReplyFindingSchema = v.object({
  reply: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type PublicReplyFindingInput = v.InferOutput<typeof publicReplyFindingSchema>

/**
 * Set a finding's status. Deliberately narrower than the SPA's full item-status patch: a headless
 * caller may `dismiss` a finding as not applicable or `reopen` one it dismissed by mistake.
 * `answered` is reached by REPLYING (which is what records the answer the incorporation folds in),
 * and `recommend_requested` drives an in-app-only affordance, so neither is settable here.
 */
export const publicSetFindingStatusSchema = v.object({
  status: v.picklist(['dismissed', 'open']),
})
export type PublicSetFindingStatusInput = v.InferOutput<typeof publicSetFindingStatusSchema>

/**
 * Incorporate the recorded answers. Optional `feedback` is the "do it differently" lever when
 * redoing a merge, exactly as in the SPA. Asynchronous: the durable driver folds and re-reviews in
 * the background, so the response is the `incorporating` review, not the finished document.
 */
export const publicIncorporateSchema = v.object({
  feedback: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
})
export type PublicIncorporateInput = v.InferOutput<typeof publicIncorporateSchema>

/**
 * Resolve a review that hit its iteration cap: one more reviewer pass, proceed with the last
 * incorporated document, or stop and reset the task to an editable state. The same three choices
 * the SPA offers — there is deliberately no timed default (a parked run waits for an answer
 * indefinitely, so a silent auto-proceed would ship requirements nobody approved).
 */
export const publicResolveExceededSchema = v.object({
  choice: v.picklist(['extra-round', 'proceed', 'stop-reset']),
})
export type PublicResolveExceededInput = v.InferOutput<typeof publicResolveExceededSchema>

/**
 * Choose an implementation approach: EXACTLY one of a proposed `forkId` or a free-text `custom`
 * approach, optionally with a steering `note` on a picked fork. Mirrors the SPA's `chooseForkSchema`
 * (same xor rule and bounds) so both surfaces accept identical input.
 */
export const publicChooseForkSchema = v.pipe(
  v.object({
    forkId: v.optional(v.nullable(v.string())),
    custom: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(8000)))),
    note: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(4000)))),
  }),
  v.check(
    (c) => (c.forkId != null && c.forkId.length > 0) !== (c.custom != null && c.custom.length > 0),
    'Provide exactly one of forkId or custom.',
  ),
)
export type PublicChooseForkInput = v.InferOutput<typeof publicChooseForkSchema>

/**
 * Resolve a parked judge verdict from a headless caller. Identical to the SPA's
 * {@link resolveJudgeSchema} — the two surfaces drive the SAME service method, so there is
 * nothing to narrow: `proceed` / `bounce` / `stop` mean exactly the same thing either way.
 */
export const publicResolveJudgeSchema = resolveJudgeSchema
export type PublicResolveJudgeInput = v.InferOutput<typeof publicResolveJudgeSchema>

/**
 * Resolve a run parked on the PRE-DISPATCH INPUT GATE from a headless caller. Identical to the
 * SPA's {@link resolveInputGateSchema} — both surfaces drive the SAME service method, so there
 * is nothing to narrow: `recheck` re-evaluates the task as it now stands (which is what actually
 * clears the park, so an integration fixes the task over `PATCH /api/v1/tasks/:taskId` first),
 * and `proceed` waives the findings and records who did it.
 */
export const publicResolveInputGateSchema = resolveInputGateSchema
export type PublicResolveInputGateInput = v.InferOutput<typeof publicResolveInputGateSchema>
