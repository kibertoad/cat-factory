import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Consensus-orchestration wire contracts.
//
// Consensus is a general MECHANISM (not one specific step): an eligible agent
// step can be run through a multi-model process — a specialist panel, a debate,
// or ranked voting/scoring — to produce a higher-quality result of the SAME
// shape that single-actor agent would have produced (a polished document, an
// aggregate of observations, occasionally structured scores). It is opt-in per
// step in the pipeline builder and lives behind a separate optional package
// (`@cat-factory/consensus`); these are the shared wire shapes.
//
// Because the process is expensive it can be GATED on a task's estimate (see
// {@link taskEstimateSchema}, produced by the core `task-estimator` agent): a
// sub-threshold task transparently runs the standard single-actor agent instead.
// ---------------------------------------------------------------------------

const scoreSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1))

/** The consensus strategy a step uses. Mirrors the consensus capability traits. */
export const consensusStrategySchema = v.picklist(['specialist-panel', 'debate', 'ranked-voting'])
export type ConsensusStrategy = v.InferOutput<typeof consensusStrategySchema>

/**
 * A single participant in a consensus session: a named role, an optional extra
 * system framing that biases its perspective (e.g. "argue for the simplest
 * viable design"), and the model it runs on. `modelId` absent ⇒ the step/block
 * default model. Diversity of role + model is what makes consensus useful, so a
 * session should carry ≥2 participants with distinct framings/models.
 */
export const consensusParticipantSchema = v.object({
  id: v.string(),
  /** Human-facing role label, e.g. "Pragmatist", "Security reviewer". */
  role: v.string(),
  /** Extra perspective framing folded into this participant's system prompt. */
  systemFraming: v.optional(v.string()),
  /** Model catalog id this participant runs on; absent ⇒ step/block default. */
  modelId: v.optional(v.string()),
})
export type ConsensusParticipant = v.InferOutput<typeof consensusParticipantSchema>

/**
 * Optional gating of the (expensive) consensus process on the task's estimate.
 * When `enabled`, consensus runs only if ANY supplied axis is met or exceeded
 * (risk ≥ minRisk OR impact ≥ minImpact OR complexity ≥ minComplexity);
 * otherwise the standard single-actor agent runs. `onMissingEstimate` decides
 * what to do when no estimate is available (default `consensus`, i.e. fail-safe
 * to thoroughness).
 */
export const consensusGatingSchema = v.object({
  enabled: v.boolean(),
  minComplexity: v.optional(scoreSchema),
  minRisk: v.optional(scoreSchema),
  minImpact: v.optional(scoreSchema),
  onMissingEstimate: v.optional(v.picklist(['consensus', 'standard']), 'consensus'),
})
export type ConsensusGating = v.InferOutput<typeof consensusGatingSchema>

/**
 * Optional gating of whether a pipeline STEP runs at all, on the task's estimate
 * (the same three axes as {@link consensusGatingSchema}, produced by the core
 * `task-estimator` agent). When `enabled`, the step runs only if ANY supplied axis
 * is met or exceeded (risk ≥ minRisk OR impact ≥ minImpact OR complexity ≥
 * minComplexity); otherwise it is transparently SKIPPED at runtime. `onMissingEstimate`
 * decides what to do when no estimate is available (default `run`, i.e. fail-safe to
 * thoroughness). A step carrying enabled gating requires a `task-estimator` earlier in
 * the pipeline — the builder/engine reject a pipeline that gates without one. Used today
 * to make a companion (reviewer / architect-companion / spec-companion) conditional on
 * how heavy the task is.
 */
export const stepGatingSchema = v.object({
  enabled: v.boolean(),
  minComplexity: v.optional(scoreSchema),
  minRisk: v.optional(scoreSchema),
  minImpact: v.optional(scoreSchema),
  onMissingEstimate: v.optional(v.picklist(['run', 'skip']), 'run'),
})
export type StepGating = v.InferOutput<typeof stepGatingSchema>

const consensusRoundsSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5))

/**
 * The consensus configuration stored on a pipeline step (set in the builder for
 * a step whose agent kind carries a consensus trait). When `enabled` is false
 * the step runs as the standard agent.
 *
 * A step declares its panel in one of two ways:
 *
 *  - **inline** — `participants` (plus `strategy`/`rounds`/`synthesizerModelId`/`gating`)
 *    authored on the step itself. One panel, one bar.
 *  - **by GROUP** — {@link groupIds} naming entries of the workspace's reusable
 *    {@link consensusGroupSchema} library, each carrying its OWN estimate bar. At dispatch the
 *    engine picks the most demanding group the task's estimate clears and materialises its
 *    panel onto this config; none clearing ⇒ the standard single-actor agent runs. That is what
 *    makes "a light duo above 0.4 risk, the full panel above 0.8" one step rather than three.
 */
export const consensusStepConfigSchema = v.object({
  enabled: v.boolean(),
  strategy: consensusStrategySchema,
  participants: v.array(consensusParticipantSchema),
  /** Model that runs the neutral synthesis / judging pass; absent ⇒ step default. */
  synthesizerModelId: v.optional(v.string()),
  /** Debate rounds (1..5); ignored by non-debate strategies. Default applied by the engine. */
  rounds: v.optional(consensusRoundsSchema),
  /** Optional gating of the process on the task estimate; absent ⇒ always run when enabled. */
  gating: v.optional(consensusGatingSchema),
  /**
   * Ids of the workspace consensus groups this step may escalate to. Order is NOT precedence —
   * the engine ranks the candidates by the bar each one sets, so adding a group never depends
   * on where it lands in the array. Non-empty ⇒ the inline `participants` are ignored and the
   * selected group's panel is used instead.
   */
  groupIds: v.optional(v.array(v.string())),
  /**
   * The group the engine SELECTED for this dispatch, stamped onto the run's copy of the config
   * when {@link groupIds} resolved. Never authored in the builder — it is the record of which
   * tier fired, carried through to the session transcript so a reviewer can see why five models
   * ran. Absent on an inline-participant step.
   */
  selectedGroup: v.optional(v.object({ id: v.string(), name: v.string() })),
})
export type ConsensusStepConfig = v.InferOutput<typeof consensusStepConfigSchema>

// ---- The workspace consensus-group library --------------------------------

/**
 * A named, reusable consensus panel ("model group") in a workspace's library: the
 * participants (roles + framings + models), the strategy that runs them, the synthesizer, and
 * the ESTIMATE BAR a task must clear for this group to be selected.
 *
 * The bar is what makes a library of groups more than a snippet store. A step names a SET of
 * groups; each group's {@link ConsensusGroup.gating} declares how heavy a task has to be before
 * it is worth that panel's cost, and the engine picks the most demanding one the task clears.
 * A group whose gating is disabled is the unconditional floor — it applies to every task the
 * step runs on, which is how "always at least a two-model review" is expressed.
 */
export const consensusGroupSchema = v.object({
  id: v.string(),
  name: v.string(),
  /** Optional prose note on what this panel is for, shown in the pickers. */
  description: v.optional(v.string()),
  strategy: consensusStrategySchema,
  participants: v.array(consensusParticipantSchema),
  synthesizerModelId: v.optional(v.string()),
  rounds: v.optional(consensusRoundsSchema),
  /**
   * The estimate bar this group sets. `enabled: false` ⇒ no bar (the group always applies).
   * Required — a group in a tiered set must state where it sits, and the disabled form says
   * "at the bottom" explicitly rather than by omission.
   */
  gating: consensusGatingSchema,
  createdAt: v.number(),
})
export type ConsensusGroup = v.InferOutput<typeof consensusGroupSchema>

// ---- Request bodies -------------------------------------------------------

const groupNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60))
const groupDescriptionSchema = v.pipe(v.string(), v.trim(), v.maxLength(400))
/**
 * A panel needs at least two distinct voices to be a panel at all (the executor's own
 * `participants.length < 2` backstop would otherwise silently degrade the step to the standard
 * agent — a refusal at the write boundary is the one a user can act on). Capped so one group
 * cannot fan a single step into an unbounded number of billed model calls.
 */
const groupParticipantsSchema = v.pipe(
  v.array(consensusParticipantSchema),
  v.minLength(2),
  v.maxLength(8),
)

/** Create a consensus group in a workspace's library. */
export const createConsensusGroupSchema = v.object({
  name: groupNameSchema,
  description: v.optional(groupDescriptionSchema),
  strategy: consensusStrategySchema,
  participants: groupParticipantsSchema,
  synthesizerModelId: v.optional(v.string()),
  rounds: v.optional(consensusRoundsSchema),
  gating: v.optional(consensusGatingSchema),
})
export type CreateConsensusGroupInput = v.InferOutput<typeof createConsensusGroupSchema>

/** Patch a consensus group (all fields optional; arrays/objects replace wholesale). */
export const updateConsensusGroupSchema = v.object({
  name: v.optional(groupNameSchema),
  description: v.optional(groupDescriptionSchema),
  strategy: v.optional(consensusStrategySchema),
  participants: v.optional(groupParticipantsSchema),
  synthesizerModelId: v.optional(v.string()),
  rounds: v.optional(consensusRoundsSchema),
  gating: v.optional(consensusGatingSchema),
})
export type UpdateConsensusGroupInput = v.InferOutput<typeof updateConsensusGroupSchema>

/**
 * What an estimate's scores were formed ON, which is the difference between a forecast and a
 * measurement of the same three axes:
 *
 *  - `predicted`: scored BEFORE any design or implementation, from the clarified requirements
 *    and the spec (the inline `task-estimator`). A forecast.
 *  - `observed`: scored AFTER the work landed, from the change that was actually made (the
 *    read-only `task-reassessor`, which reads the run's pull-request diff).
 *
 * PERSISTED and CLOSED, and OPTIONAL on the record rather than defaulted into it: a stored
 * estimate is read back with a plain `JSON.parse` and no schema pass, so a row written before the
 * vocabulary existed genuinely carries no basis, and a type claiming otherwise would tell every
 * reader the field is always there. Absence READS as `predicted` (every one of those rows came
 * from the estimator, which is a fact about them rather than a guess), and a value this build
 * cannot name is stated as unrecognised rather than guessed onto a current member: narrow with
 * {@link isTaskEstimateBasis} before indexing anything by it.
 */
export const TASK_ESTIMATE_BASES = ['predicted', 'observed'] as const
export const taskEstimateBasisSchema = v.picklist(TASK_ESTIMATE_BASES)
export type TaskEstimateBasis = v.InferOutput<typeof taskEstimateBasisSchema>

const TASK_ESTIMATE_BASIS_SET: ReadonlySet<string> = new Set(taskEstimateBasisSchema.options)

/**
 * Whether a value is a basis THIS BUILD knows, DERIVED from the picklist's own options so a
 * member added later cannot leave this behind. A stored estimate may name a member since
 * retired, and a browser may hold a bundle older than the member it reads.
 */
export function isTaskEstimateBasis(value: unknown): value is TaskEstimateBasis {
  return typeof value === 'string' && TASK_ESTIMATE_BASIS_SET.has(value)
}

/**
 * The last reading of the OTHER basis, kept on the current record so a forecast survives the
 * measurement that corrected it and stays readable beside it. The platform derives the delta from
 * the pair (see `reviseTaskEstimate`); nothing asks a model what it changed.
 *
 * The other basis, rather than simply the previous record: a re-run of the SAME reading INHERITS
 * this instead of overwriting it, because a retried measurement replaces its predecessor and would
 * otherwise delete the forecast the comparison exists for.
 *
 * ONE level deep, deliberately: this carries no `supersedes` of its own, so a board row holds the
 * pair rather than an unbounded chain. The per-run history lives in the runs themselves.
 */
export const supersededTaskEstimateSchema = v.object({
  complexity: scoreSchema,
  risk: scoreSchema,
  impact: scoreSchema,
  /** Absent ⇒ `predicted`, for the same reason it is on {@link taskEstimateSchema}. */
  basis: v.optional(taskEstimateBasisSchema),
  model: v.optional(v.nullable(v.string())),
  createdAt: v.number(),
})
export type SupersededTaskEstimate = v.InferOutput<typeof supersededTaskEstimateSchema>

/**
 * A triage of a task along three axes (each 0..1; higher = more complex / riskier / higher
 * blast-radius), persisted on the block, surfaced in the UI, used to gate consensus and
 * conditional steps, and to sort the board's lanes by impact. This is CORE: it ships
 * independent of the consensus package.
 *
 * TWO agent kinds write it and {@link basis} says which: the inline `task-estimator` FORECASTS
 * it before any design work, and the container `task-reassessor` MEASURES it afterwards against
 * the change that was actually made. The block holds one record (the platform's current best
 * answer) and a measurement that replaced a forecast carries that forecast in
 * {@link supersedes}, so "how well did we predict this" stays answerable without a second field
 * nothing gates on.
 */
export const taskEstimateSchema = v.object({
  complexity: scoreSchema,
  risk: scoreSchema,
  impact: scoreSchema,
  /** The estimator's plain-prose justification for the scores. */
  rationale: v.string(),
  /** Identifier of the model that produced the estimate, for transparency. */
  model: v.optional(v.nullable(v.string())),
  createdAt: v.number(),
  /** What the scores were formed on; absent ⇒ `predicted` (see {@link taskEstimateBasisSchema}). */
  basis: v.optional(taskEstimateBasisSchema),
  /** The last reading of the OTHER basis, when there was one. */
  supersedes: v.optional(v.nullable(supersededTaskEstimateSchema)),
})
export type TaskEstimate = v.InferOutput<typeof taskEstimateSchema>

// ---- Session transcript (the persisted + streamed observability surface) ----

/** One scored dimension a ranked-voting participant assigned (0..1). */
export const consensusScoreSchema = v.object({
  dimension: v.string(),
  value: scoreSchema,
  rationale: v.optional(v.string()),
})
export type ConsensusScore = v.InferOutput<typeof consensusScoreSchema>

/** One participant's contribution within a round (an argument, critique, or scoring). */
export const consensusContributionSchema = v.object({
  participantId: v.string(),
  text: v.string(),
  scores: v.optional(v.array(consensusScoreSchema)),
})
export type ConsensusContribution = v.InferOutput<typeof consensusContributionSchema>

/** A single round of the process. `kind` distinguishes the dialectic phases. */
export const consensusRoundSchema = v.object({
  index: v.number(),
  kind: v.optional(v.picklist(['draft', 'critique', 'score'])),
  contributions: v.array(consensusContributionSchema),
})
export type ConsensusRound = v.InferOutput<typeof consensusRoundSchema>

export const consensusSessionStatusSchema = v.picklist([
  'running',
  'synthesizing',
  'done',
  'failed',
])
export type ConsensusSessionStatus = v.InferOutput<typeof consensusSessionStatusSchema>

/**
 * The full transcript of a consensus session: who participated, the round-by-round
 * contributions, the synthesized result, and confidence/dissent. Persisted
 * (`consensus_sessions`) and streamed live so the dedicated window can visualize
 * the process. One per (executionId, stepIndex).
 */
export const consensusSessionSchema = v.object({
  id: v.string(),
  blockId: v.string(),
  executionId: v.nullable(v.string()),
  stepIndex: v.number(),
  /** The underlying agent kind this session ran for (e.g. `architect`). */
  agentKind: v.string(),
  strategy: consensusStrategySchema,
  status: consensusSessionStatusSchema,
  /**
   * The workspace consensus group whose panel ran, when the step resolved one from its
   * {@link ConsensusStepConfig.groupIds} tier set. Null for an inline-participant step. Stored
   * on the transcript rather than re-derived, because the library entry can be edited or
   * deleted after the run and the session must still say which panel actually fired.
   */
  groupId: v.optional(v.nullable(v.string())),
  /** The selected group's name AS IT WAS at dispatch (the library row may since have changed). */
  groupName: v.optional(v.nullable(v.string())),
  participants: v.array(consensusParticipantSchema),
  rounds: v.array(consensusRoundSchema),
  /** The neutral synthesis / winning result; null until the synthesis pass completes. */
  synthesis: v.nullable(v.string()),
  /** Aggregate confidence in the result (0..1), when the strategy yields one. */
  confidence: v.optional(v.nullable(v.number())),
  /** Notable unresolved disagreements surfaced by the synthesizer. */
  dissent: v.optional(v.array(v.string())),
  /** Failure detail when `status` is `failed`. */
  error: v.optional(v.nullable(v.string())),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type ConsensusSession = v.InferOutput<typeof consensusSessionSchema>

/** Parse-or-throw a task estimate payload an agent returned (the engine validates it). */
export function parseTaskEstimate(value: unknown): TaskEstimate {
  return v.parse(taskEstimateSchema, value)
}

/** Parse-or-throw a consensus step config (used when persisting builder edits). */
export function parseConsensusStepConfig(value: unknown): ConsensusStepConfig {
  return v.parse(consensusStepConfigSchema, value)
}
