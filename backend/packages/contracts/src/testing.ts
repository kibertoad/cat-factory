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
 * A Tester's structured report. `greenlight` is the gate's verdict: true means the
 * change is safe to release (no blocking concerns); false routes the run through
 * the `fixer`. `tested` lists what the Tester decided to cover (this task's
 * requirements plus best-judgement regression of related ones); `outcomes` are the
 * per-area results; `concerns` are the bugs/risks to fix before re-testing.
 */
export const testReportSchema = v.object({
  /** The gate verdict: release-ready (true) or needs fixing (false). */
  greenlight: v.boolean(),
  /** Plain-prose overall summary of the testing session. */
  summary: v.string(),
  /** What the Tester chose to exercise (requirements + regression areas). */
  tested: v.array(v.string()),
  /** Per-area results. */
  outcomes: v.array(testOutcomeSchema),
  /** Bugs/risks uncovered; non-empty implies `greenlight` should be false. */
  concerns: v.array(testConcernSchema),
  /** Which environment the suite ran in, echoed back for the UI. */
  environment: v.optional(v.picklist(['local', 'ephemeral'])),
})
export type TestReport = v.InferOutput<typeof testReportSchema>

/** Parse-or-throw a test report payload an agent returned (the engine validates it). */
export function parseTestReport(value: unknown): TestReport {
  return v.parse(testReportSchema, value)
}
