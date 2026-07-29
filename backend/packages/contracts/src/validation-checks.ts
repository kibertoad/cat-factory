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
 * The service's DEPENDENCY PREPOPULATION command: the install the harness runs against the
 * checkout BEFORE the coding agent's first turn, so the agent reads a tree that has its
 * dependencies present (`node_modules`, a populated `.venv`, a warm module cache) rather than
 * inferring capabilities from a manifest. Same shape and trust boundary as a check's command —
 * it runs as `sh -c` in the run's own container — but a different PHASE and a different
 * disposition: prepopulation is setup, never a gate, so a failure is reported to the agent and
 * the run continues. See `docs/initiatives/agent-dependency-prepopulation.md`.
 */
const dependencyInstallSchema = validationCommandSchema

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
    /**
     * The pre-agent dependency install. Independent of `checks`: a service may declare ONLY
     * this (prepopulate the checkout, verify nothing) or only checks. An empty/omitted value
     * clears it.
     */
    dependencyInstall: v.optional(dependencyInstallSchema),
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
  /** The pre-agent dependency install, when the service declared one. */
  dependencyInstall: v.optional(v.string()),
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
  /**
   * The pre-agent dependency install resolved for this dispatch. Carried on the SAME resolved
   * object as the checks because it comes from the same frame-chain read — so prepopulation
   * costs the dispatch no extra round trip — but it is threaded onto the job body SEPARATELY
   * (every checkout-having dispatch, not only a PR-opening one).
   */
  dependencyInstall: v.optional(v.string()),
})
export type ResolvedValidationChecks = v.InferOutput<typeof resolvedValidationChecksSchema>

// ---- Autodetection --------------------------------------------------------

/**
 * The ecosystems the pre-PR validation AUTODETECTOR recognises at a repo's root. The
 * detection rules live in `@cat-factory/kernel` (`domain/validation-detectors.ts`); this
 * picklist is the wire vocabulary, so the SPA can label each hit from its own catalog
 * rather than rendering a backend-authored string.
 *
 * Adding a member here is what makes a new detector reachable: the kernel detector's
 * `ecosystem` id is typed against this union, and the SPA's exhaustive label map fails to
 * typecheck until the locale key exists.
 */
export const VALIDATION_ECOSYSTEMS = [
  'node',
  'python',
  'go',
  'rust',
  'maven',
  'gradle',
  'dotnet',
  'ruby',
  'php',
  'elixir',
  'make',
  'just',
  'task',
] as const
export const validationEcosystemSchema = v.picklist(VALIDATION_ECOSYSTEMS)
export type ValidationEcosystem = v.InferOutput<typeof validationEcosystemSchema>

/**
 * How a detection attempt ended. Stated rather than inferred from an empty result: "this
 * service has no repo linked", "GitHub could not be read" and "we read the repo and
 * recognised nothing" need three different things from the operator, and collapsing them
 * into one empty list tells them to go looking in the wrong place.
 */
export const validationDetectionStatusSchema = v.picklist(['ok', 'repo_unavailable', 'failed'])
export type ValidationDetectionStatus = v.InferOutput<typeof validationDetectionStatusSchema>

/**
 * What `GET .../validation-checks/detect` returns: the checks the repo's own manifests,
 * scripts and tool configs imply. A SUGGESTION only — the endpoint writes nothing, so the
 * operator reviews (and edits) the rows before saving them as the service's config.
 */
export const detectedValidationChecksSchema = v.object({
  status: validationDetectionStatusSchema,
  /** Every ecosystem that contributed a suggestion, in the detector's canonical order. */
  ecosystems: v.array(validationEcosystemSchema),
  checks: v.array(validationCheckSchema),
  /** Whether {@link VALIDATION_MAX_CHECKS} dropped suggestions the detectors produced. */
  truncated: v.boolean(),
  /**
   * The suggested DEPENDENCY PREPOPULATION command — every detected ecosystem's install,
   * chained with `&&`. Suggested independently of {@link checks}: an ecosystem that declares an
   * install but nothing to verify contributes no check (an install alone verifies nothing) yet
   * is exactly the case prepopulation exists for. Absent when nothing detected needs one.
   */
  dependencyInstall: v.optional(v.string()),
})
export type DetectedValidationChecks = v.InferOutput<typeof detectedValidationChecksSchema>

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
