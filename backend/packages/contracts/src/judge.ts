import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Judge wire contracts — the FOURTH step-taxonomy bucket (see `CLAUDE.md`: agents /
// polling gates / one-shot engine steps / judges).
//
// A judge step runs an LLM assessment of the run's work against a RUBRIC, producing a
// structured verdict; the engine compares the verdict's score to a PER-TASK threshold
// (a merge-preset knob) and disposes: advance, park for a human, bounce the preceding
// producing step with the findings as rework feedback, or fail the run.
//
// This generalises a shape three engine paths already had (requirements auto-pass, the
// merger's scored assessment, the on-call culprit confidence) into a registry a
// DEPLOYMENT can extend — `JudgeRegistry` in kernel, mirroring `GateRegistry`. All live
// state rides the run's step (`PipelineStep.judge`), so it is runtime-symmetric by
// construction with no side table — the `forkDecision` / `gate` precedent.
//
// See `docs/initiatives/judge-registry.md`.
// ---------------------------------------------------------------------------

/** Default minimum verdict score (0..1) a judge requires to advance the run. */
export const DEFAULT_JUDGE_MIN_SCORE = 0.7

/** Default number of bounce rounds a judge may spend before it must ask a human. */
export const DEFAULT_JUDGE_MAX_BOUNCES = 1

/** How serious one judge finding is. Ordered low < medium < high < critical. */
export const judgeFindingSeveritySchema = v.picklist(['low', 'medium', 'high', 'critical'])
export type JudgeFindingSeverity = v.InferOutput<typeof judgeFindingSeveritySchema>

/**
 * One concrete thing the rubric flagged. `title` is the headline a human (or the bounced
 * producer) acts on; `detail` is the evidence. Both are MODEL-AUTHORED text — every render
 * of them onto a host-parsed surface (the PR body) goes through kernel's `hostMarkdown`
 * helpers plus `redactSecrets`, exactly like the rest of the verification report.
 */
export const judgeFindingSchema = v.object({
  title: v.fallback(v.string(), 'Untitled finding'),
  detail: v.fallback(v.optional(v.string()), undefined),
  severity: v.fallback(judgeFindingSeveritySchema, 'medium'),
  /** Where the finding applies, when the judge could localise it (`path` or `path:line`). */
  where: v.fallback(v.optional(v.string()), undefined),
})
export type JudgeFinding = v.InferOutput<typeof judgeFindingSchema>

/**
 * The canonical structured verdict a judge's assessment returns. A registration MAY supply
 * its own valibot schema (the driver parses against whatever it registered), but the value
 * must still expose a `score` — that is the number the per-task threshold compares — so the
 * shared window and the PR report can render any judge without knowing its rubric.
 *
 * Every field is `v.fallback`-wrapped so ONE noisy field degrades to its default instead of
 * discarding an otherwise-usable verdict (the `securityAssessment` precedent in the example
 * custom-agent package): a model that reports `score` on a 0..100 scale must not cost us the
 * findings beside it.
 */
export const judgeVerdictSchema = v.object({
  /** How well the work meets the rubric, 0..1 (higher is better). Missing ⇒ 0 (fails). */
  score: v.fallback(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0),
  /** The judge's prose justification — what it looked at and why it scored that way. */
  summary: v.fallback(v.string(), ''),
  /** What the rubric flagged. Empty on a clean verdict. */
  findings: v.optional(v.fallback(v.array(judgeFindingSchema), []), []),
})
export type JudgeVerdict = v.InferOutput<typeof judgeVerdictSchema>

/**
 * What the engine DID with a verdict:
 *  - `pass`   — at or above the threshold; the run advances.
 *  - `park`   — a human must decide (the registration's `onFail`, or a spent bounce budget).
 *  - `bounce` — the preceding producing step was re-armed with the findings as rework.
 *  - `fail`   — the run was failed with the verdict summary.
 */
export const judgeDispositionSchema = v.picklist(['pass', 'park', 'bounce', 'fail'])
export type JudgeDisposition = v.InferOutput<typeof judgeDispositionSchema>

/**
 * The judge step's lifecycle:
 *  - `evaluating`        — the assessment is running (transient; the driver holds the step).
 *  - `awaiting_decision` — parked; a human picks proceed / bounce / stop.
 *  - `bouncing`          — the producer was re-armed; the judge re-runs when it returns.
 *  - `passed` / `failed` — settled.
 *  - `skipped`           — no assessor wired (pass-through), or nothing to judge.
 */
export const judgeStatusSchema = v.picklist([
  'evaluating',
  'awaiting_decision',
  'bouncing',
  'passed',
  'failed',
  'skipped',
])
export type JudgeStatus = v.InferOutput<typeof judgeStatusSchema>

/**
 * What became of the model a judge REGISTRATION pinned for its rubric:
 *  - `applied`: the assessment ran on the pinned model;
 *  - `overridden`: something more specific won (the task's own pin, or a workspace preset that
 *    names this judge's kind). The pin is a default, so this is the normal case;
 *  - `unavailable`: the pinned id resolved to nothing this deployment can serve, so the
 *    assessment ran on the workspace/deployment default instead.
 *
 * `unavailable` is the reason this is a field rather than a silent fallback: a rubric authored
 * for a strong reasoning model, scored by whatever the workspace's base preset happens to be,
 * reads exactly like a verdict that model gave.
 */
export const judgeModelPinStatusSchema = v.picklist(['applied', 'overridden', 'unavailable'])
export type JudgeModelPinStatus = v.InferOutput<typeof judgeModelPinStatusSchema>

/** The registration's model pin, and what the engine did with it. */
export const judgeModelPinSchema = v.object({
  /** The catalog model id the judge's registration asked for. */
  requested: v.string(),
  status: judgeModelPinStatusSchema,
})
export type JudgeModelPin = v.InferOutput<typeof judgeModelPinSchema>

/** One completed round of the judge loop (assessment + what the engine did with it). */
export const judgeRoundSchema = v.object({
  /** 1-based round number; the first assessment is round 1. */
  round: v.number(),
  at: v.number(),
  verdict: judgeVerdictSchema,
  disposition: judgeDispositionSchema,
  /** The model that produced this round's verdict. */
  model: v.optional(v.nullable(v.string())),
})
export type JudgeRound = v.InferOutput<typeof judgeRoundSchema>

/**
 * Live judge state carried on the run's judge step — the analogue of `GateStepState`.
 * Created lazily by the engine on first entry; the rubric itself is NOT persisted here
 * (only its identity), since a rubric body can be many KB and the step row is re-serialized
 * on every progress write.
 */
export const judgeStepStateSchema = v.object({
  status: judgeStatusSchema,
  /** The rubric's stable id (the registration's, or the overriding fragment's). */
  rubricId: v.optional(v.nullable(v.string())),
  /** The rubric's human name, for the window + the PR report. */
  rubricName: v.optional(v.nullable(v.string())),
  /** Whether the rubric body came from a workspace fragment override rather than the default. */
  rubricOverridden: v.optional(v.boolean(), false),
  /** The most recent verdict; null until the first assessment settles. */
  verdict: v.optional(v.nullable(judgeVerdictSchema)),
  /** The score the verdict had to reach, resolved from the task's merge preset. */
  threshold: v.optional(v.nullable(v.number())),
  /** What the engine did with the most recent verdict. */
  disposition: v.optional(v.nullable(judgeDispositionSchema)),
  /** How many bounce rounds have been spent, and the ceiling from the merge preset. */
  bounces: v.optional(v.number(), 0),
  maxBounces: v.optional(v.number(), DEFAULT_JUDGE_MAX_BOUNCES),
  /** The model that produced the most recent verdict. */
  model: v.optional(v.nullable(v.string())),
  /**
   * The registration's model pin and its fate, when the judge declared one. Absent ⇒ the judge
   * named no model and the assessment ran on the workspace/deployment default, which is the
   * stock case and needs no explaining.
   */
  modelPin: v.optional(v.nullable(judgeModelPinSchema)),
  /** Every settled round, oldest first — so the window shows the loop, not just its end. */
  rounds: v.optional(v.array(judgeRoundSchema), []),
  /**
   * Why the judge is `skipped`, or why a disposition degraded (e.g. a `bounce` with no
   * preceding producing step to bounce to). Surfaced verbatim in the window + PR report,
   * because a judge that quietly did nothing is indistinguishable from one that passed.
   */
  note: v.optional(v.nullable(v.string())),
  /**
   * Set true when the run's risk policy ANSWERED this judge's rework cap instead of parking on
   * it (`autonomy: 'unattended'`), taking the "proceed anyway" choice a person would have been
   * offered. The sibling of `step.companion.capSettledByPolicy`, and there for the same reason:
   * the last round's verdict says the work was below the bar either way, so without this the
   * step reads exactly like one whose judge scored it acceptable.
   *
   * Only ever set for the BUDGET-SPENT park. A judge that declared `onFail: 'park'` asked for a
   * person, and one with no producing step to bounce to never got to try — neither is the
   * automation giving up, and autonomy leaves both alone (see kernel's `JudgeParkReason`).
   */
  capSettledByPolicy: v.optional(v.boolean()),
  /** The human's resolution of a park, once made. */
  resolution: v.optional(
    v.nullable(
      v.object({
        choice: v.picklist(['proceed', 'bounce', 'stop']),
        feedback: v.optional(v.nullable(v.string())),
        at: v.number(),
      }),
    ),
  ),
})
export type JudgeStepState = v.InferOutput<typeof judgeStepStateSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Resolve a parked judge:
 *  - `proceed` — advance despite the verdict (the human overrules the rubric);
 *  - `bounce`  — spend a rework round on the producing step, even past the budget;
 *  - `stop`    — fail the run.
 * `feedback` is folded into a `bounce`'s rework brief (and recorded either way).
 */
export const resolveJudgeSchema = v.object({
  choice: v.picklist(['proceed', 'bounce', 'stop']),
  feedback: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(4000)))),
})
export type ResolveJudgeInput = v.InferOutput<typeof resolveJudgeSchema>

/** Parse-or-throw a verdict payload an assessment returned (the engine validates it). */
export function parseJudgeVerdict(value: unknown): JudgeVerdict {
  return v.parse(judgeVerdictSchema, value)
}
