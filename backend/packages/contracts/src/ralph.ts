import * as v from 'valibot'

// The "Ralph loop" wire contracts. A ralph step runs a persistent retry-until-done loop: a
// fresh-context coding iteration works the task spec, then the HARNESS runs a configured
// programmatic validation command against the checkout and reports its exit code — the
// authoritative completion criterion (exit 0 = done), never the model's self-report. The
// engine loops the iteration until the command passes or a per-task iteration budget is
// spent. The loop state rides `PipelineStep.ralph` (persisted inside the run's `detail`
// blob, so it survives restarts with no dedicated table), mirroring `gate`/`test`.

/**
 * The harness-computed verdict of one ralph iteration's validation run. Produced by the
 * executor-harness (it runs the command and reads the exit code) and carried back on the
 * runner result → {@link AgentRunResult.ralphVerdict}; the engine reads it to decide
 * done / retry / exhausted. It is deliberately NOT model output — that is the whole point
 * of a programmatic exit condition. Lenient (`v.fallback`) so a malformed field degrades
 * rather than discarding the whole verdict.
 */
export const ralphVerdictSchema = v.object({
  /** Whether the validation command exited 0 (the completion criterion is met). */
  validationPassed: v.fallback(v.boolean(), false),
  /** The validation command's exit code (0 = pass). */
  exitCode: v.fallback(v.number(), 1),
  /** A bounded tail of the validation command's combined output (for feedback + display). */
  validationOutputTail: v.fallback(v.optional(v.string()), undefined),
  /** 1-based iteration number the harness ran this validation for. */
  iteration: v.fallback(v.optional(v.number()), undefined),
})
export type RalphVerdict = v.InferOutput<typeof ralphVerdictSchema>

/** Parse-or-throw a harness ralph verdict (lenient — malformed fields degrade to defaults). */
export function parseRalphVerdict(value: unknown): RalphVerdict {
  return v.parse(ralphVerdictSchema, value)
}

/**
 * One recorded ralph iteration (append-only history on the step). Captures both what the
 * iteration produced and how its validation ended, so the result view can show an
 * inspectable timeline instead of a bare attempt count — the ralph analogue of
 * `TesterAttempt` / `GateAttempt`.
 */
export const ralphAttemptSchema = v.object({
  /** 1-based iteration number. */
  attempt: v.number(),
  /** Epoch ms when the iteration job finished. */
  at: v.number(),
  /** Whether this iteration's validation command passed (exit 0). */
  validationPassed: v.boolean(),
  /** The validation command's exit code for this iteration. */
  exitCode: v.optional(v.nullable(v.number())),
  /** A bounded tail of the validation output for this iteration. */
  outputTail: v.optional(v.nullable(v.string())),
  /** The iteration's own account of what it changed (its prose output), for the timeline. */
  summary: v.optional(v.nullable(v.string())),
})
export type RalphAttempt = v.InferOutput<typeof ralphAttemptSchema>

/**
 * Live loop state for a ralph step, persisted on {@link PipelineStep.ralph} (rides the run's
 * `detail` JSON blob — no migration). Seeded at step start from the block's per-task agent
 * config (the validation command + iteration budget), then mutated each iteration by the
 * engine's `RalphController`. Because it lives on the persisted step, both durable drivers
 * and both stale-run sweepers re-drive a mid-loop run from exactly this state after a
 * restart — the "survives restarts" requirement, for free.
 */
export const ralphStepStateSchema = v.object({
  /** The loop only ever iterates; kept as a field for symmetry with gate/test phases. */
  phase: v.picklist(['iterating']),
  /** How many iterations have been dispatched so far. */
  attempts: v.number(),
  /** Ceiling on iterations (the anti-runaway budget), frozen from agent config at step start. */
  maxIterations: v.number(),
  /** The programmatic completion criterion: a shell command the harness runs (exit 0 = done). */
  validationCommand: v.string(),
  /** Repo-relative path of the append-only progress log the harness maintains on the branch. */
  progressPath: v.optional(v.nullable(v.string())),
  /** The most recent iteration's validation exit code (for the UI). */
  lastExitCode: v.optional(v.nullable(v.number())),
  /** A bounded tail of the most recent iteration's validation output. */
  lastValidationTail: v.optional(v.nullable(v.string())),
  /** Append-only history of the iterations this loop ran. */
  attemptLog: v.optional(v.nullable(v.array(ralphAttemptSchema))),
})
export type RalphStepState = v.InferOutput<typeof ralphStepStateSchema>
