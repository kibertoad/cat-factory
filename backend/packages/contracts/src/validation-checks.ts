import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Pre-PR validation checks.
//
// A service declares shell commands (install / lint / test / build) that the
// executor-harness runs against the CHECKOUT after the coding agent settles and
// BEFORE the PR is opened. A failing command's captured output is handed back to
// the agent as its next instruction, and the loop repeats until the commands pass
// or the attempt budget is spent — a programmatic exit condition, computed by the
// harness, never self-reported by the model. Only a passing checkout opens a PR;
// an exhausted budget FAILS the step with the last captured output.
//
// Config is per SERVICE FRAME (resolved up the frame chain), mirroring the
// `test_secrets` / `release_health_configs` shape, and travels to the container IN
// THE JOB BODY (containers have no DB access). See
// docs/initiatives/pre-pr-validation.md.
// ---------------------------------------------------------------------------

/** A short operator-facing label for a check (`lint`, `unit tests`, `build`). */
const validationCheckLabelSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80))

/**
 * The shell command a check runs, executed as `sh -c <command>` in the checkout (the
 * service directory for a monorepo service). Runs INSIDE the sandboxed run container —
 * the same trust boundary as the coding agent — so there is no host/backend execution.
 */
const validationCommandSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000))

/** One configured validation check: what to run and what to call it. */
export const validationCheckSchema = v.object({
  label: validationCheckLabelSchema,
  command: validationCommandSchema,
})
export type ValidationCheck = v.InferOutput<typeof validationCheckSchema>

/**
 * How many times the harness may re-run the agent against failing checks before giving up.
 * Bounded so a wedged service can't burn a container indefinitely. `1` = run the checks once
 * and fail on the first red (no repair round).
 *
 * MIRRORED in the executor-harness (`executor-harness/src/job.ts`), which clamps the same field
 * off the job body but takes no dependency on this package. Change both together: the harness
 * silently capping a budget this schema accepts would be invisible from either side.
 */
export const VALIDATION_DEFAULT_MAX_ATTEMPTS = 3
export const VALIDATION_MAX_ATTEMPTS_CEILING = 10

const validationMaxAttemptsSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(VALIDATION_MAX_ATTEMPTS_CEILING),
)

/** At most this many checks per service — the loop runs them in order, so the list stays short. */
export const VALIDATION_MAX_CHECKS = 10

/** Set/replace a service's validation checks. An empty list clears the config. */
export const upsertServiceValidationConfigSchema = v.pipe(
  v.object({
    checks: v.array(validationCheckSchema),
    /** Repair-round budget; omitted ⇒ {@link VALIDATION_DEFAULT_MAX_ATTEMPTS}. */
    maxAttempts: v.optional(validationMaxAttemptsSchema),
  }),
  v.check(
    (o) => new Set(o.checks.map((c) => c.label)).size === o.checks.length,
    'validation check labels must be unique within a service',
  ),
  v.check(
    (o) => o.checks.length <= VALIDATION_MAX_CHECKS,
    `at most ${VALIDATION_MAX_CHECKS} validation checks per service`,
  ),
)
export type UpsertServiceValidationConfigInput = v.InferOutput<
  typeof upsertServiceValidationConfigSchema
>

/** What `GET .../validation-checks` returns for one service frame. */
export const serviceValidationConfigSchema = v.object({
  /** The service-frame block these checks belong to. */
  blockId: v.string(),
  checks: v.array(validationCheckSchema),
  maxAttempts: v.number(),
})
export type ServiceValidationConfig = v.InferOutput<typeof serviceValidationConfigSchema>

/**
 * The RESOLVED checks a dispatch carries: the frame-chain walk's result, folded onto the
 * agent run context and forwarded on the coding job body. `null`/absent ⇒ the service
 * configured none, so the harness runs its existing (unvalidated) path unchanged.
 */
export const resolvedValidationChecksSchema = v.object({
  checks: v.array(validationCheckSchema),
  maxAttempts: v.number(),
})
export type ResolvedValidationChecks = v.InferOutput<typeof resolvedValidationChecksSchema>

// ---- The harness-produced report ------------------------------------------

/** One command's outcome in a validation attempt. */
export const validationCheckOutcomeSchema = v.object({
  label: v.fallback(v.string(), 'check'),
  command: v.fallback(v.string(), ''),
  /** Exit code (0 = pass); 124 on watchdog timeout, 127 on spawn failure, 130 on abort. */
  exitCode: v.fallback(v.number(), 1),
  passed: v.fallback(v.boolean(), false),
  /** Bounded, secret-scrubbed tail of the command's combined stdout+stderr. */
  outputTail: v.fallback(v.optional(v.string()), undefined),
  /** Wall-clock of the command, ms. */
  durationMs: v.fallback(v.optional(v.number()), undefined),
  /** Set when the command was killed by the per-command watchdog. */
  timedOut: v.fallback(v.optional(v.boolean()), undefined),
})
export type ValidationCheckOutcome = v.InferOutput<typeof validationCheckOutcomeSchema>

/**
 * The harness-computed report of a run's pre-PR validation: whether the LAST attempt's
 * commands all passed, how many attempts were spent, and each command's outcome in that
 * attempt. Produced by the executor-harness (it runs the commands and reads the exit codes)
 * and carried back on the runner view/result → {@link AgentRunResult.validationReport}; the
 * engine records it on the step. Lenient (`v.fallback`) so a malformed field degrades rather
 * than discarding the whole report.
 */
export const validationReportSchema = v.object({
  /** Whether every command in the latest attempt exited 0 (⇒ the PR was allowed to open). */
  passed: v.fallback(v.boolean(), false),
  /** How many agent+check rounds ran (1 = the checks passed/failed on the first pass). */
  attempts: v.fallback(v.number(), 1),
  /** The budget the loop ran under, so the UI can show "3 / 3 attempts". */
  maxAttempts: v.fallback(v.number(), VALIDATION_DEFAULT_MAX_ATTEMPTS),
  /** Per-command outcomes of the LATEST attempt, in configured order. */
  outcomes: v.fallback(v.array(validationCheckOutcomeSchema), []),
  /** Epoch ms the latest attempt finished. */
  at: v.fallback(v.optional(v.number()), undefined),
})
export type ValidationReport = v.InferOutput<typeof validationReportSchema>

/** Parse-or-throw a harness validation report (lenient — malformed fields degrade to defaults). */
export function parseValidationReport(value: unknown): ValidationReport {
  return v.parse(validationReportSchema, value)
}

/**
 * The one-line human summary of a failed validation report, used as the step's failure detail
 * when the attempt budget is spent. Names the failing checks + their exit codes so the run
 * detail is actionable without opening the report.
 */
export function summarizeValidationFailure(report: ValidationReport): string {
  const failed = report.outcomes.filter((o) => !o.passed)
  const names = failed.map((o) => `${o.label} (exit ${o.exitCode})`).join(', ')
  return (
    `Pre-PR validation failed after ${report.attempts} of ${report.maxAttempts} attempt(s)` +
    (names ? `: ${names}` : '') +
    '. No pull request was opened.'
  )
}
