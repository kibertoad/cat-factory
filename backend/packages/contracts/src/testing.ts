import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Tester / Fixer wire contracts.
//
// The `tester` agent runs the project's tests — either against a provisioned
// ephemeral environment or with its dependencies stood up locally (the Tester's
// contributed `tester.environment` config picks which) — and returns a structured
// report of what it exercised and what it found. If the report withholds its
// greenlight (concerns/bugs surfaced), the engine dispatches the dedicated
// `fixer` agent, hands it the report, and re-runs the Tester against the fixed
// branch — looping until the Tester greenlights or the attempt budget is spent.
// This mirrors the CI → ci-fixer gate, but the gate's signal is the Tester's own
// structured report rather than GitHub check runs.
// ---------------------------------------------------------------------------

/**
 * Where the Tester stands up the system under test: `local` runs the dependencies
 * locally via the service's docker-compose file (or "no infra"), `ephemeral` runs
 * against a provisioned ephemeral environment. Picked per-task (the Tester's
 * `tester.environment` config), defaulting to the service frame's chosen default.
 */
export const testEnvironmentSchema = v.picklist(['local', 'ephemeral'])
export type TestEnvironment = v.InferOutput<typeof testEnvironmentSchema>

/**
 * The test quality-control companion's agent kind. It is a companion of the `tester-api`
 * and `tester-ui` agents (never a standalone pipeline step): after the Tester produces a
 * report, this inline reviewer judges whether the report adequately covers what the Tester
 * claimed to test and, when it doesn't, loops the Tester for a more thorough pass BEFORE the
 * greenlight/fixer decision. This package is the single source of truth for the string.
 */
export const TESTER_QC_AGENT_KIND = 'tester-qc'

/** How serious a concern the Tester surfaced is. */
export const testConcernSeveritySchema = v.picklist(['low', 'medium', 'high', 'critical'])
export type TestConcernSeverity = v.InferOutput<typeof testConcernSeveritySchema>

/** A bug or risk the Tester uncovered, to be addressed by the `fixer` before re-test. */
export const testConcernSchema = v.object({
  /** Short subject of the concern. */
  title: v.string(),
  /** What's wrong / what was observed, concretely. */
  detail: v.string(),
  /** Severity, so the fixer (and a human) can triage. */
  severity: testConcernSeveritySchema,
})
export type TestConcern = v.InferOutput<typeof testConcernSchema>

/** The result of exercising one tested area / requirement. */
export const testOutcomeSchema = v.object({
  /** What was exercised (a requirement, scenario or area). */
  name: v.string(),
  /** Whether it passed, failed, or could not be run. */
  status: v.picklist(['passed', 'failed', 'skipped']),
  /** Optional detail (the failure message, why it was skipped, etc.). */
  detail: v.optional(v.string()),
})
export type TestOutcome = v.InferOutput<typeof testOutcomeSchema>

/**
 * One screenshot the UI tester (`tester-ui`) captured of a distinct view while
 * exercising the functionality. The bytes are uploaded to the binary-artifact store
 * during the run (so they never bloat the report JSON); this entry references the
 * stored artifact by id. `referenceArtifactId` links the matching reference design
 * image (when one was supplied) so the visual-confirmation gate can pair actual vs
 * reference by `view`.
 */
export const testScreenshotSchema = v.object({
  /** Logical view name (pairs with a reference design image of the same view). */
  view: v.string(),
  /** The stored artifact id (in the binary-artifact store) for the captured PNG. */
  artifactId: v.string(),
  /** Content hash — drives non-redundant capture (one shot per distinct view). */
  hash: v.optional(v.string()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  /** The matching reference design image's artifact id, when one was supplied. */
  referenceArtifactId: v.optional(v.string()),
})
export type TestScreenshot = v.InferOutput<typeof testScreenshotSchema>

/**
 * How a spec requirement fared when the Tester went looking for it. THREE-VALUED on purpose:
 * "we didn't check" and "it's broken" must never render the same, which is the entire point of
 * keeping the list — a reviewer reading a two-valued list cannot tell a requirement that was
 * verified from one nobody looked at.
 *
 *  - `met`         — its acceptance criteria were exercised and observed to hold.
 *  - `not_met`     — exercised and observed NOT to hold.
 *  - `not_covered` — not exercised this run (out of the change's blast radius, unreachable in
 *                    this setup, or simply not yet built — an `aspirational` requirement is
 *                    EXPECTED to land here and must never be reported as `not_met`).
 */
export const requirementVerdictStatusSchema = v.picklist(['met', 'not_met', 'not_covered'])
export type RequirementVerdictStatus = v.InferOutput<typeof requirementVerdictStatusSchema>

/**
 * One requirement-level verdict, keyed by the **spec requirement id** (`spec/modules/<m>/<g>.json`
 * → `requirements[].id`, surfaced to the Tester as the `# requirement: <id>` comment above each
 * Gherkin scenario). Deliberately the SAME id space as the spec — a second id space would make
 * the join to `spec/` guesswork, which is what sank the withdrawn per-service store.
 *
 * Two consumers read this, and they must agree: the promotion post-op flips a `met` requirement
 * from `aspirational` to `established` in the in-repo spec, and the PR verification report joins
 * it back to the spec to render criterion → evidence.
 */
export const requirementVerdictSchema = v.object({
  /** The spec requirement's stable id (e.g. `req-login-rate-limit`). */
  requirementId: v.string(),
  status: requirementVerdictStatusSchema,
  /** What was actually observed — the evidence behind the verdict. */
  detail: v.optional(v.string()),
})
export type RequirementVerdict = v.InferOutput<typeof requirementVerdictSchema>

/**
 * A Tester's structured report. `greenlight` is the gate's verdict: true means the
 * change is safe to release (no blocking concerns); false routes the run through
 * the `fixer`. `tested` lists what the Tester decided to cover (this task's
 * requirements plus best-judgement regression of related ones); `outcomes` are the
 * per-area results; `concerns` are the bugs/risks to fix before re-testing.
 */
const testReportObjectSchema = v.object({
  /** The gate verdict: release-ready (true) or needs fixing (false). */
  greenlight: v.boolean(),
  /** Plain-prose overall summary of the testing session. */
  summary: v.string(),
  /** What the Tester chose to exercise (requirements + regression areas). */
  tested: v.array(v.string()),
  /** Per-area results. */
  outcomes: v.array(testOutcomeSchema),
  /**
   * Bugs/risks uncovered. A `high`/`critical` (blocking) concern implies
   * `greenlight` must be false; `low`/`medium` concerns are advisory and do not, on
   * their own, withhold the greenlight. The engine re-applies this rule defensively.
   */
  concerns: v.array(testConcernSchema),
  /**
   * Per-spec-requirement verdicts, keyed by the requirement id the Gherkin scenarios carry.
   * Optional: absent on a run whose service has no `spec/`, and on every report produced before
   * this contract existed — both read as "no requirement was ruled on", never as a failure.
   */
  requirementVerdicts: v.optional(v.array(requirementVerdictSchema)),
  /** Which environment the suite ran in, echoed back for the UI. */
  environment: v.optional(testEnvironmentSchema),
  /**
   * Non-redundant screenshots of the views the UI tester exercised (one per distinct
   * view). Empty/absent for the API tester (`tester-api`), which captures none. Backs
   * the visual-confirmation gate's actual-vs-reference review.
   */
  screenshots: v.optional(v.array(testScreenshotSchema)),
  /**
   * Set when the Tester could NOT run a meaningful test at all and the run must STOP for a
   * human rather than loop the fixer — e.g. the ephemeral environment it was configured to
   * use never came up, a required dependency was unavailable, or the change simply can't be
   * exercised in this setup. The engine then blocks the task (retryable) and raises a
   * notification WITHOUT dispatching the `fixer` (which can't fix missing infrastructure).
   * This is distinct from a withheld greenlight (bugs were found → loop the fixer); when
   * `abort` is set, `greenlight` MUST be false. The `reason` is shown to the human verbatim.
   */
  abort: v.optional(v.nullable(v.object({ reason: v.string() }))),
})

/**
 * Enforce the `abort ⇒ greenlight === false` invariant at the schema boundary so it can't
 * depend on every caller getting the ordering right: a report that signals `abort` is never
 * release-ready, so normalise `greenlight` to false whenever an `abort` reason is present.
 * (The container executor's `coerceTestReport` already forces this on the dispatch path; the
 * transform makes it hold for every parse — e.g. re-validating persisted step state too.)
 */
export const testReportSchema = v.pipe(
  testReportObjectSchema,
  v.transform((report) => (report.abort?.reason ? { ...report, greenlight: false } : report)),
)
export type TestReport = v.InferOutput<typeof testReportSchema>

/** Parse-or-throw a test report payload an agent returned (the engine validates it). */
export function parseTestReport(value: unknown): TestReport {
  return v.parse(testReportSchema, value)
}

/**
 * The record of standing the service's docker-compose dependencies up before a `local`
 * tester run. The stand-up happens INSIDE the executor container (`docker compose up
 * --wait`), so its output never reaches the orchestrator-side provisioning-log store
 * (which records only the backend's container/env spin-up). The harness captures it
 * (redacted + tail-bounded) and the engine persists it on the Tester step, so the test
 * window can show WHY the dependencies failed to come up — the single highest-signal
 * artifact for a local-infra Tester failure, previously trapped in the harness's own logs.
 */
export const testerInfraSetupSchema = v.object({
  /** Whether `docker compose up --wait` succeeded (the dependencies are up). */
  started: v.boolean(),
  /**
   * Whether the executor container had a Docker daemon to talk to, when it knows. The
   * distinction `started` alone cannot make: a compose stack that failed to come up and an
   * executor with no daemon are the same `started: false` and opposite fixes (the service's
   * compose file, versus the image or the sandbox running it). Absent/null means the container
   * reached no verdict — an image predating the probe, or the native host transport, which runs
   * the harness with no entrypoint to probe. Never read absence as `false`.
   */
  dockerAvailable: v.optional(v.nullable(v.boolean())),
  /**
   * What a real container DID on that daemon, when the platform measured it. The third
   * diagnosis, and the one `dockerAvailable` structurally cannot carry: a rootless daemon nested
   * in a sandbox answers throughout while unable to mount any image layer, so it is reachable and
   * no stack can come up on it. Reporting that as an absent daemon sends a human to restart one
   * that is already up. `undetermined` is a check that ran and could not tell; absent/null means
   * nothing was measured at all (an older image, or the native host transport).
   */
  dockerWorkload: v.optional(v.nullable(v.picklist(['usable', 'unusable', 'undetermined']))),
  /**
   * What a container started ON that daemon could REACH, when the platform measured it.
   *
   * The fourth diagnosis, and the one `dockerWorkload: 'usable'` structurally cannot carry: a
   * rootless daemon started with `--iptables=false` runs containers perfectly and installs no
   * MASQUERADE rule for its bridge, so none of them has a route out. The stack comes up and every
   * `docker build` that fetches a dependency fails, slowly, which reads on the step as a stack
   * that is fine. Present only alongside `usable`, the one verdict with an egress half;
   * absent/null means nothing measured it.
   */
  dockerEgress: v.optional(v.nullable(v.picklist(['reachable', 'blocked', 'undetermined']))),
  /** The repo-relative compose file that was stood up, when known. */
  composePath: v.optional(v.nullable(v.string())),
  /** Epoch ms the stand-up attempt finished. */
  at: v.number(),
  /** Wall-clock of the stand-up attempt, ms. */
  durationMs: v.optional(v.nullable(v.number())),
  /** Captured (redacted, tail-bounded) stdout+stderr of the stand-up command. */
  logs: v.optional(v.nullable(v.string())),
  /** The verbatim (redacted) failure message when stand-up failed, else null. */
  error: v.optional(v.nullable(v.string())),
})
export type TesterInfraSetup = v.InferOutput<typeof testerInfraSetupSchema>

/**
 * Parse a tester infra-setup record the harness reported, or null when absent/malformed.
 * The data is harness-produced (deterministic, not LLM), but it crosses the container→
 * backend HTTP boundary, so the engine validates it defensively before persisting.
 */
export function parseTesterInfraSetup(value: unknown): TesterInfraSetup | null {
  const result = v.safeParse(testerInfraSetupSchema, value)
  return result.success ? result.output : null
}
