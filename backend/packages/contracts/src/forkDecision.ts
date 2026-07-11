import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Implementation-fork decision wire contracts. Before the Coder (agentKind
// `coder`, the standard `build` phase) writes any code, an optional read-only
// `fork-proposer` explore agent aggressively surfaces the MATERIALLY different
// ways the task could be implemented ("patch the call site vs refactor the
// seam", "migrate the schema vs adapt the mapper", "targeted fix vs behind a
// flag"). The run then PARKS for the human to pick a proposed fork, enter their
// own free-text approach, or chat about the forks before deciding; the chosen
// fork is folded into the Coder's prompt as a binding directive.
//
// The phase lives INSIDE the coder step (a two-phase coder step): phase A is the
// proposer explore dispatch, then the human park, then phase B is the ordinary
// Coder dispatch with the chosen approach folded in. It is gated on the task
// Estimator's estimate via the workspace risk policy (see `riskPolicySchema`),
// plus a per-task tri-state (`auto`/`always`/`off`). All state rides the run's
// coder step (`PipelineStep.forkDecision`) — no side table — so it is
// runtime-symmetric by construction, exactly like `followUps` / `testerQuality`.
// ---------------------------------------------------------------------------

/**
 * Default hard budget on grounded chat turns (human messages) before a 409. The single source
 * of truth for the cap, referenced by the `maxChatTurns` schema default below, the orchestration
 * gate logic, and the window's UI fallback so the three can't drift.
 */
export const DEFAULT_FORK_MAX_CHAT_TURNS = 15

/**
 * One materially different implementation approach the proposer surfaced. Two
 * forks are materially different only if they lead to different code being
 * reviewed, different risk, or different future maintenance — naming/style
 * variants of one approach are ONE fork. `id` is engine-minted (`fork_*`).
 */
export const forkOptionSchema = v.object({
  /** Engine-minted stable id (`fork_*`); assigned when the proposal is recorded. */
  id: v.string(),
  /** Short headline of the approach. */
  title: v.string(),
  /** One-line gist of what this approach does. */
  summary: v.string(),
  /** The concrete plan: seams/files/modules touched and the order of work. */
  approach: v.string(),
  /** Honest pros AND cons of this approach (both directions). */
  tradeoffs: v.array(v.string()),
  /** Anything irreversible this approach entails (schema, wire contracts, data). */
  riskNotes: v.optional(v.nullable(v.string())),
  /** The proposer marks exactly one fork recommended. */
  recommended: v.optional(v.boolean()),
})
export type ForkOption = v.InferOutput<typeof forkOptionSchema>

/**
 * One turn in the grounded fork chat. Assistant turns are appended by the durable
 * driver's inline LLM call (the chat responder). Chat is delivered live on the
 * `execution` event — there is no dedicated chat table.
 */
export const forkChatMessageSchema = v.object({
  id: v.string(),
  role: v.picklist(['human', 'assistant']),
  text: v.pipe(v.string(), v.maxLength(4000)),
  createdAt: v.number(),
})
export type ForkChatMessage = v.InferOutput<typeof forkChatMessageSchema>

/**
 * The fork-decision lifecycle on a coder step:
 * - `proposing`: the `fork-proposer` explore job is in flight (phase A).
 * - `awaiting_choice`: parked; the human picks / types a custom approach / chats.
 * - `answering`: a chat turn is pending (`pendingForkChat` set; the driver is
 *   computing the reply). Re-enters `awaiting_choice` once the reply is appended.
 * - `chosen`: the human decided; the Coder dispatch (phase B) runs next.
 * - `single_path`: the proposer's escape hatch fired (a trivial/obvious task or a
 *   prescribed pattern) — no park, the Coder runs directly.
 * - `skipped`: the estimate gate was not met (or tri-state `off`) — the Coder runs
 *   directly, exactly as before the feature existed.
 */
export const forkDecisionStatusSchema = v.picklist([
  'proposing',
  'awaiting_choice',
  'answering',
  'chosen',
  'single_path',
  'skipped',
])
export type ForkDecisionStatus = v.InferOutput<typeof forkDecisionStatusSchema>

/**
 * The human's resolution: EXACTLY one of a picked `forkId` or a free-text `custom`
 * approach (enforced by the xor check). A picked fork may carry a steering `note`.
 */
export const forkChoiceSchema = v.pipe(
  v.object({
    /** The chosen proposed fork's id; absent when the human entered a custom approach. */
    forkId: v.optional(v.nullable(v.string())),
    /** The human's own free-text approach; absent when a proposed fork was picked. */
    custom: v.optional(v.nullable(v.string())),
    /** Optional steering note the human added to a picked fork. */
    note: v.optional(v.nullable(v.string())),
    at: v.number(),
  }),
  v.check(
    (c) => (c.forkId != null) !== (c.custom != null),
    'Provide exactly one of forkId or custom.',
  ),
)
export type ForkChoice = v.InferOutput<typeof forkChoiceSchema>

/**
 * Live fork-decision state carried on the run's coder step. Created lazily by the
 * engine when the phase activates (the config itself never lives on the step —
 * it's on the block + the risk policy). `seamSummary` is the proposer's read of
 * where the change lands (grounding for the human + the chat); `maxChatTurns`
 * bounds inline LLM spend and step-row size; `model` records the proposing model.
 */
export const forkDecisionStepStateSchema = v.object({
  status: forkDecisionStatusSchema,
  /** The proposer's read of where the change lands (the seam it identified). */
  seamSummary: v.optional(v.nullable(v.string())),
  /** The materially different approaches; empty until the proposer completes. */
  forks: v.optional(v.array(forkOptionSchema), []),
  /** Why the proposer took the single-path escape hatch, when `status` is `single_path`. */
  singlePathReason: v.optional(v.nullable(v.string())),
  /** The grounded chat so far (human + assistant turns), in order. */
  chat: v.optional(v.array(forkChatMessageSchema), []),
  /** Hard budget on chat turns (human messages); a 409 is returned past it. */
  maxChatTurns: v.optional(v.number(), DEFAULT_FORK_MAX_CHAT_TURNS),
  /** The human's resolution once decided; absent while proposing / awaiting. */
  chosen: v.optional(v.nullable(forkChoiceSchema)),
  /** Identifier of the model that produced the proposal, for transparency. */
  model: v.optional(v.nullable(v.string())),
})
export type ForkDecisionStepState = v.InferOutput<typeof forkDecisionStepStateSchema>

// ---- Request bodies -------------------------------------------------------

/** Send a human chat message about the proposed forks (the reply arrives via the stream). */
export const forkChatRequestSchema = v.object({
  text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type ForkChatRequestInput = v.InferOutput<typeof forkChatRequestSchema>

/**
 * Choose an implementation fork: EXACTLY one of a proposed `forkId` or a free-text
 * `custom` approach (≤8000 chars). A picked fork may carry a steering `note`.
 */
export const chooseForkSchema = v.pipe(
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
export type ChooseForkInput = v.InferOutput<typeof chooseForkSchema>

/**
 * The lenient structured shape the `fork-proposer` explore agent returns (the
 * engine mints ids / records it onto the step). `singlePath` is the escape hatch:
 * when true, any competent senior engineer would implement it the same way, so no
 * park happens and the Coder runs directly against the one returned fork.
 */
export const forkProposalSchema = v.object({
  /** The proposer's read of where the change lands. */
  seamSummary: v.optional(v.string(), ''),
  forks: v.optional(
    v.array(
      v.object({
        title: v.optional(v.string(), ''),
        summary: v.optional(v.string(), ''),
        approach: v.optional(v.string(), ''),
        tradeoffs: v.optional(v.array(v.string()), []),
        riskNotes: v.optional(v.nullable(v.string())),
        recommended: v.optional(v.boolean()),
      }),
    ),
    [],
  ),
  /** True ⇒ trivial/obvious/prescribed; return the one fork and skip the park. */
  singlePath: v.optional(v.boolean(), false),
  singlePathReason: v.optional(v.nullable(v.string())),
})
export type ForkProposal = v.InferOutput<typeof forkProposalSchema>
