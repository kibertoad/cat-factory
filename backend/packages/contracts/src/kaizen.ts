import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Kaizen wire contracts. The Kaizen agent is a continuous-improvement reviewer
// that runs AFTER an agent step finishes (it is never a pipeline-builder step).
// It reads the context + prompt the step was given and the per-call interaction
// telemetry, then judges whether the interaction was smooth / guided / efficient
// or confused / chaotic, returning a 1..5 grade plus improvement recommendations.
//
// A grading targets one completed step, identified by its `(promptVersion,
// agentKind, model)` combo. When a combo earns a high grade (4 or 5) with no
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

/**
 * The states in which the grader is DONE with a grading, whatever it concluded.
 *
 * One definition because three layers ask the same question and must agree: the acknowledge route
 * refuses anything else, and both facades' conditional UPDATE carries the same predicate so the
 * refusal cannot be raced. `failed` is in it deliberately: a grading that could not run names a
 * deployment problem somebody has to act on, which is precisely a thing to acknowledge.
 */
export const KAIZEN_SETTLED_STATUSES = [
  'complete',
  'failed',
] as const satisfies readonly KaizenGradingStatus[]

/** Whether a grading has settled, so it can be acknowledged. */
export function isSettledKaizenStatus(status: KaizenGradingStatus): boolean {
  return (KAIZEN_SETTLED_STATUSES as readonly KaizenGradingStatus[]).includes(status)
}

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
  /**
   * Epoch ms somebody recorded that this grading has been triaged, or null while it is still
   * outstanding. Acknowledgement is a state of the ENTRY, not of the grading: it is written by
   * a human (or the integration standing in for one) after reading the recommendations, and the
   * grading sweep never touches it, so a re-graded row keeps whatever was acknowledged about it.
   *
   * Its whole purpose is to make "what has nobody looked at yet" answerable, which a
   * recommendations list alone cannot be: `GET /api/v1/kaizen/entries?acknowledged=false` is the
   * work queue, and without a persisted acknowledgement every poll re-reports the same backlog.
   */
  acknowledgedAt: v.nullable(v.number()),
  /**
   * WHO acknowledged it: a user id (`usr_*`) when the acting key was minted onto a person,
   * otherwise the public-API key (`pak_*`) that recorded it. Null while unacknowledged.
   *
   * One field rather than two, because the question a follow-up asks is "who do I go back to",
   * and a key that acts as nobody IS the answerable party for its own acknowledgements.
   */
  acknowledgedBy: v.nullable(v.string()),
  /** What the acknowledger wanted the next reader to know (a ticket id, a decision), or null. */
  acknowledgementNote: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type KaizenGrading = v.InferOutput<typeof kaizenGradingSchema>

/**
 * A `(promptVersion, agentKind, model)` combo's verification progress. The combo
 * earns a high grade each time a grading returns grade 4 or 5 with no recommendations;
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
