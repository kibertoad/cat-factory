import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Kaizen wire contracts. The Kaizen agent is a continuous-improvement reviewer
// that runs AFTER an agent step finishes (it is never a pipeline-builder step).
// It reads the context + prompt the step was given and the per-call interaction
// telemetry, then judges whether the interaction was smooth / guided / efficient
// or confused / chaotic, returning a 1..5 grade plus improvement recommendations.
//
// A grading targets one completed step, identified by its `(promptVersion,
// agentKind, model)` combo. When a combo earns a high grade (5) with no
// recommendations VERIFICATION_STREAK (5) times in a row it is marked VERIFIED
// and is no longer graded. Both the grading history and the verified combos are
// persisted (D1 ⇄ Drizzle parity) and surfaced on the Kaizen screen; per-run
// grading status is surfaced inside the run window (never on the board).
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a single grading:
 * - `scheduled`: queued at run completion, awaiting the background sweep.
 * - `running`: the sweep picked it up and the grader LLM is analysing.
 * - `complete`: the grade + recommendations are recorded.
 * - `failed`: the grader call errored (telemetry missing, model unwired, parse
 *   failure); recorded with an `error` and never retried automatically.
 */
export const kaizenGradingStatusSchema = v.picklist(['scheduled', 'running', 'complete', 'failed'])
export type KaizenGradingStatus = v.InferOutput<typeof kaizenGradingStatusSchema>

/** A single Kaizen grading of one completed agent step. */
export const kaizenGradingSchema = v.object({
  id: v.string(),
  /** The run (execution) the graded step belongs to. */
  executionId: v.string(),
  /** The board block the run targets — for linking back from the Kaizen screen. */
  blockId: v.string(),
  /** Index of the graded step within the run's pipeline. */
  stepIndex: v.number(),
  /** The graded step's agent kind (e.g. `coder`, `architect`). */
  agentKind: v.string(),
  /** The resolved model id the step ran on (e.g. `claude-opus-4-...`). */
  model: v.string(),
  /** The graded step's prompt version (from the agents prompt-version registry). */
  promptVersion: v.number(),
  /** `agentKind|model|promptVersion` — the verified-combo key. */
  comboKey: v.string(),
  status: kaizenGradingStatusSchema,
  /** 1..5 once `complete` (5 = smooth/guided/efficient); null while pending/failed. */
  grade: v.nullable(v.number()),
  /** The grader's prose summary of how the interaction went. Empty while pending. */
  summary: v.string(),
  /** Actionable improvement recommendations. Empty array ⇒ nothing to improve. */
  recommendations: v.array(v.string()),
  /** `provider:model` that produced the grade, for transparency; null in tests. */
  graderModel: v.nullable(v.string()),
  /** Error message when `failed`, else null. */
  error: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type KaizenGrading = v.InferOutput<typeof kaizenGradingSchema>

/**
 * A `(promptVersion, agentKind, model)` combo's verification progress. The combo
 * earns a high grade each time a grading returns grade 5 with no recommendations;
 * `consecutiveHighGrades` resets to 0 on anything lower. At VERIFICATION_STREAK it
 * flips `verified` true and the engine stops scheduling gradings for it.
 */
export const kaizenVerifiedComboSchema = v.object({
  /** `agentKind|model|promptVersion`. */
  comboKey: v.string(),
  agentKind: v.string(),
  model: v.string(),
  promptVersion: v.number(),
  /** Count of sequential high grades with no recommendations. */
  consecutiveHighGrades: v.number(),
  verified: v.boolean(),
  /** When the combo crossed the streak threshold, else null. */
  verifiedAt: v.nullable(v.number()),
  updatedAt: v.number(),
})
export type KaizenVerifiedCombo = v.InferOutput<typeof kaizenVerifiedComboSchema>

/** The Kaizen screen payload: recent grading history + the verified-combo library. */
export const kaizenOverviewSchema = v.object({
  gradings: v.array(kaizenGradingSchema),
  verified: v.array(kaizenVerifiedComboSchema),
})
export type KaizenOverview = v.InferOutput<typeof kaizenOverviewSchema>

/** The gradings recorded for a single run, for the run-window status surface. */
export const kaizenRunGradingsSchema = v.object({
  gradings: v.array(kaizenGradingSchema),
})
export type KaizenRunGradings = v.InferOutput<typeof kaizenRunGradingsSchema>
