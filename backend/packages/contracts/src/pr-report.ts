import * as v from 'valibot'
import { mergeAssessmentSchema } from './merge.js'
import { vcsProviderSchema } from './routes/auth.js'

// ---------------------------------------------------------------------------
// PR verification report — the structured evidence bundle the ENGINE maintains on a
// run's pull request.
//
// The PR an agent run opens used to carry only whatever prose the coder agent wrote, so a
// reviewer had to take "tests pass" on faith. The platform already CAPTURES the facts (the
// `ci` gate's aggregated check runs, the tester's structured report, the deployer's
// per-frame environment outcomes, the merger's scored assessment, the per-step models); this
// is the wire shape that composes them into one report the engine writes onto the PR body —
// captured facts, never the agent's assertions.
//
// It is rendered as human-readable markdown PLUS a fenced JSON block carrying exactly this
// shape, so external tooling can ingest a report without scraping prose. See
// `docs/initiatives/pr-verification-report.md` for the form/shape decisions and
// `@cat-factory/kernel`'s `domain/pr-report.ts` for the marker-delimited splice that keeps
// the write idempotent across re-runs and retries.
// ---------------------------------------------------------------------------

/**
 * The wire version of the report payload. Bumped when the JSON shape changes in a way an
 * external consumer must notice. Backwards compatibility is a non-goal (see CLAUDE.md), so
 * a bump means "re-read the schema", not "a compatibility shim exists".
 */
export const PR_VERIFICATION_REPORT_VERSION = 1

/**
 * Whether a section has evidence to show.
 *  - `reported` — the producing step ran and its evidence is below.
 *  - `absent`   — no producing step in this pipeline (or it never settled). `note` says so
 *                 explicitly; a section is NEVER silently omitted, because "no tester section"
 *                 and "the tester found nothing" must not look the same to a reviewer.
 */
export const prReportSectionStatusSchema = v.picklist(['reported', 'absent'])
export type PrReportSectionStatus = v.InferOutput<typeof prReportSectionStatusSchema>

/** One pipeline step, as the report's run metadata lists it. */
export const prReportStepSchema = v.object({
  /** 0-based position in the pipeline. */
  index: v.number(),
  /** The step's agent kind (`coder`, `ci`, `tester-api`, `merger`, a custom kind, …). */
  agentKind: v.string(),
  /** The step's terminal state at compose time (`done`, `running`, `failed`, …). */
  state: v.string(),
  /** The model actually resolved for the step, when one ran. */
  model: v.optional(v.nullable(v.string())),
})
export type PrReportStep = v.InferOutput<typeof prReportStepSchema>

/** One tracker issue the task is linked to (GitHub Issues / Jira / Linear). */
export const prReportIssueSchema = v.object({
  /** The task source the issue came from (`github` / `jira` / `linear` / …). */
  source: v.string(),
  /** The issue's id in that source (issue number, Jira key, …). */
  externalId: v.string(),
  title: v.string(),
  url: v.string(),
})
export type PrReportIssue = v.InferOutput<typeof prReportIssueSchema>

/** Run metadata: what task this PR implements, and how it was produced. */
export const prReportRunSchema = v.object({
  /** The `ExecutionInstance` id — the key the observability panel is scoped by. */
  executionId: v.string(),
  /** The board block (task) the run implements. */
  blockId: v.string(),
  blockTitle: v.string(),
  pipelineId: v.string(),
  pipelineName: v.string(),
  /** The repo the run targeted, `owner/name`, when resolved. */
  repo: v.optional(v.nullable(v.string())),
  /** The VCS provider the repo lives on — neutral vocabulary, never assumed to be GitHub. */
  provider: v.optional(v.nullable(vcsProviderSchema)),
  /** Epoch ms the run was created, when recorded. */
  startedAt: v.optional(v.nullable(v.number())),
  /** Every step of the pipeline, in order. */
  steps: v.array(prReportStepSchema),
  /** The tracker issues linked to the task (empty when none). */
  issues: v.array(prReportIssueSchema),
})
export type PrReportRun = v.InferOutput<typeof prReportRunSchema>

/** One CI check run, as the `ci` gate's precheck saw it. */
export const prReportCheckSchema = v.object({
  name: v.string(),
  /** The provider's conclusion (`success`, `failure`, `timed_out`, …); null while running. */
  conclusion: v.nullable(v.string()),
  url: v.optional(v.nullable(v.string())),
  /** The repo the check belongs to, on a multi-repo task. */
  repo: v.optional(v.nullable(v.string())),
})
export type PrReportCheck = v.InferOutput<typeof prReportCheckSchema>

/**
 * The `ci` gate's verdict. Composed from the gate step's own recorded state
 * (`step.gate`) — NOT by re-probing the `CiStatusProvider`, which would cost a round trip
 * and could disagree with the verdict the gate actually acted on.
 */
export const prReportCiSchema = v.object({
  status: prReportSectionStatusSchema,
  /** Says why the section is empty when `status` is `absent`. */
  note: v.optional(v.nullable(v.string())),
  /** The gate's last precheck verdict. */
  verdict: v.optional(v.nullable(v.picklist(['pass', 'pending', 'fail']))),
  /** The PR head commit the verdict was computed against. */
  headSha: v.optional(v.nullable(v.string())),
  /**
   * The checks behind a FAILING verdict, by name + conclusion. Empty on a pass (the gate
   * records failing-check detail only, since a green run has nothing to triage).
   */
  failingChecks: v.array(prReportCheckSchema),
  /** How many `ci-fixer` rounds the gate dispatched, and its ceiling. */
  fixerAttempts: v.number(),
  maxFixerAttempts: v.optional(v.nullable(v.number())),
})
export type PrReportCi = v.InferOutput<typeof prReportCiSchema>

/** One area the tester exercised, and how it went. */
export const prReportTestOutcomeSchema = v.object({
  name: v.string(),
  status: v.string(),
  detail: v.optional(v.nullable(v.string())),
})
export type PrReportTestOutcome = v.InferOutput<typeof prReportTestOutcomeSchema>

/** One concern the tester surfaced (a bug/risk the fixer was asked to address). */
export const prReportTestConcernSchema = v.object({
  title: v.string(),
  severity: v.string(),
})
export type PrReportTestConcern = v.InferOutput<typeof prReportTestConcernSchema>

/** The tester gate's structured report (`tester-api` / `tester-ui`). */
export const prReportTestsSchema = v.object({
  status: prReportSectionStatusSchema,
  note: v.optional(v.nullable(v.string())),
  /** The tester's release verdict: did it greenlight the change? */
  greenlight: v.optional(v.nullable(v.boolean())),
  summary: v.optional(v.nullable(v.string())),
  /** Where the system under test ran (`local` docker-compose infra / `ephemeral` env). */
  environment: v.optional(v.nullable(v.string())),
  /** What the tester chose to exercise. */
  tested: v.array(v.string()),
  outcomes: v.array(prReportTestOutcomeSchema),
  concerns: v.array(prReportTestConcernSchema),
  /** How many `fixer` rounds the tester looped through, and its ceiling. */
  fixerAttempts: v.number(),
  maxFixerAttempts: v.optional(v.nullable(v.number())),
})
export type PrReportTests = v.InferOutput<typeof prReportTestsSchema>

/** One ephemeral environment the `deployer` step stood up (per service frame). */
export const prReportEnvironmentSchema = v.object({
  /** The service frame the environment was provisioned for. */
  frameId: v.string(),
  /** `ready` (live), `failed` (the provision broke) or `skipped` (an infraless frame). */
  status: v.picklist(['ready', 'failed', 'skipped']),
  url: v.optional(v.nullable(v.string())),
  error: v.optional(v.nullable(v.string())),
})
export type PrReportEnvironment = v.InferOutput<typeof prReportEnvironmentSchema>

/**
 * The ephemeral-environment lifecycle: which environments came up, and whether they were
 * torn down again. `teardown` reads the run's live environment projection:
 *  - `confirmed`      — every environment reached a torn-down/expired state.
 *  - `pending`        — at least one is still live (the run may still be using it).
 *  - `not_applicable` — nothing was ever provisioned.
 */
export const prReportEnvironmentsSchema = v.object({
  status: prReportSectionStatusSchema,
  note: v.optional(v.nullable(v.string())),
  entries: v.array(prReportEnvironmentSchema),
  teardown: v.picklist(['confirmed', 'pending', 'not_applicable']),
})
export type PrReportEnvironments = v.InferOutput<typeof prReportEnvironmentsSchema>

/**
 * The `merger` step's scored assessment plus the engine's resolved decision. `assessment` is
 * the agent's own scoring; `outcome`/`reason`/`presetName` are what the engine's
 * `MergeResolver` did with it against the task's merge preset.
 */
export const prReportMergeSchema = v.object({
  status: prReportSectionStatusSchema,
  note: v.optional(v.nullable(v.string())),
  assessment: v.optional(v.nullable(mergeAssessmentSchema)),
  outcome: v.optional(v.nullable(v.string())),
  reason: v.optional(v.nullable(v.string())),
  presetName: v.optional(v.nullable(v.string())),
})
export type PrReportMerge = v.InferOutput<typeof prReportMergeSchema>

/**
 * Where a human can inspect what every step actually did — the run's observability panel
 * (Model activity / Provided context). Built from the deployment's public app URL
 * (`appBaseUrl`); null when the deployment configured none, so the report never emits a
 * link to nowhere.
 */
export const prReportObservabilitySchema = v.object({
  runUrl: v.nullable(v.string()),
})
export type PrReportObservability = v.InferOutput<typeof prReportObservabilitySchema>

export const prVerificationReportSchema = v.object({
  /** See {@link PR_VERIFICATION_REPORT_VERSION}. */
  version: v.number(),
  /** Epoch ms the report was composed (refreshed on every publish). */
  generatedAt: v.number(),
  run: prReportRunSchema,
  ci: prReportCiSchema,
  tests: prReportTestsSchema,
  environments: prReportEnvironmentsSchema,
  merge: prReportMergeSchema,
  observability: prReportObservabilitySchema,
})
export type PrVerificationReport = v.InferOutput<typeof prVerificationReportSchema>

/**
 * Parse-or-throw a report payload — used by the conformance suite (and any external
 * consumer) to prove the JSON block the engine emitted is exactly this shape.
 */
export function parsePrVerificationReport(value: unknown): PrVerificationReport {
  return v.parse(prVerificationReportSchema, value)
}
