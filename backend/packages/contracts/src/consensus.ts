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

/**
 * The consensus configuration stored on a pipeline step (set in the builder for
 * a step whose agent kind carries a consensus trait). When `enabled` is false
 * the step runs as the standard agent.
 */
export const consensusStepConfigSchema = v.object({
  enabled: v.boolean(),
  strategy: consensusStrategySchema,
  participants: v.array(consensusParticipantSchema),
  /** Model that runs the neutral synthesis / judging pass; absent ⇒ step default. */
  synthesizerModelId: v.optional(v.string()),
  /** Debate rounds (1..5); ignored by non-debate strategies. Default applied by the engine. */
  rounds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5))),
  /** Optional gating of the process on the task estimate; absent ⇒ always run when enabled. */
  gating: v.optional(consensusGatingSchema),
})
export type ConsensusStepConfig = v.InferOutput<typeof consensusStepConfigSchema>

/**
 * A `task-estimator` agent's structured triage of a task along three axes
 * (each 0..1; higher = more complex / riskier / higher blast-radius). Produced
 * after requirements are clarified and the spec is structured, persisted on the
 * block, surfaced in the UI, and used to gate consensus steps. This is CORE —
 * it ships independent of the consensus package.
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
