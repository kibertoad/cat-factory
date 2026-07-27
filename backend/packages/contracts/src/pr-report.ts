import * as v from 'valibot'
import { mergeAssessmentSchema } from './merge.js'
import { judgeDispositionSchema, judgeFindingSchema } from './judge.js'
import { requirementPrioritySchema, requirementStateSchema } from './spec.js'
import { requirementVerdictStatusSchema } from './testing.js'
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
export const PR_VERIFICATION_REPORT_VERSION = 3

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

/**
 * One JUDGE step's recorded verdict (the fourth step-taxonomy bucket). Composed from the step's
 * own `judge` state — never by re-running the assessment, which would cost a second model call
 * and could disagree with the verdict the engine actually acted on (the same rule the CI
 * section follows about re-probing its provider).
 *
 * The rubric BODY is deliberately not carried: it is deployment/workspace policy text, often
 * long, and the reviewer acts on the findings. Every string here is model-authored and is
 * rendered through kernel's `hostMarkdown` helpers plus `redactSecrets`.
 */
export const prReportJudgeSchema = v.object({
  /** The judge step's `agentKind`, which names WHICH judge scored the work. */
  stepKind: v.string(),
  rubricName: v.nullable(v.string()),
  /** Whether the workspace overrode the registration's default rubric with its own fragment. */
  rubricOverridden: v.boolean(),
  /** The verdict's score, and the per-task threshold it was compared against. */
  score: v.nullable(v.number()),
  threshold: v.nullable(v.number()),
  /** What the engine did: pass / park for a human / bounce for rework / fail the run. */
  disposition: v.nullable(judgeDispositionSchema),
  /** The judge's prose justification. */
  summary: v.nullable(v.string()),
  /** What the rubric flagged (capped like every other list; see `truncations`). */
  findings: v.array(judgeFindingSchema),
  /** Rework rounds spent, and the ceiling from the task's merge preset. */
  bounces: v.number(),
  maxBounces: v.number(),
  /** The model that produced the verdict. */
  model: v.nullable(v.string()),
})
export type PrReportJudge = v.InferOutput<typeof prReportJudgeSchema>

/** The run's judge verdicts. `absent` when the pipeline placed no judge step (or none settled). */
export const prReportJudgesSchema = v.object({
  status: prReportSectionStatusSchema,
  /** Says why the section is empty when `status` is `absent`. */
  note: v.optional(v.nullable(v.string())),
  verdicts: v.array(prReportJudgeSchema),
})
export type PrReportJudges = v.InferOutput<typeof prReportJudgesSchema>

/**
 * One spec requirement joined to what the Tester observed about it — the report's
 * REQUIREMENT → EVIDENCE row.
 *
 * The join key is the spec's own requirement id (`spec/modules/<m>/<g>.json` →
 * `requirements[].id`), which the Gherkin render carries as a `# requirement: <id>` comment and
 * the Tester echoes in `requirementVerdicts`. One id space end to end: inventing a second one
 * is what made the withdrawn per-service store unable to reconcile with `spec/` at all.
 *
 * The acceptance criteria themselves are deliberately NOT copied here. They live in `spec/`,
 * versioned beside the code and reachable from the repo; duplicating their prose into every PR
 * body would multiply an unbounded artifact by every publish and leave a copy to rot. The row
 * carries how many there are so a reader can see the requirement was not criterion-less.
 */
export const prReportRequirementSchema = v.object({
  /** The spec requirement's stable id — the join key, and what a reader greps `spec/` for. */
  id: v.string(),
  title: v.string(),
  /** Where it lives in the spec taxonomy (module → feature group). */
  module: v.string(),
  group: v.string(),
  priority: requirementPrioritySchema,
  /**
   * Implementation state as the spec recorded it AT COMPOSE TIME. An `aspirational`
   * requirement is agreed but not yet built, so `not_covered` against it is the EXPECTED
   * reading and not a gap — which is exactly why the state has to travel with the verdict.
   */
  state: requirementStateSchema,
  /** What the Tester observed. See {@link requirementVerdictStatusSchema}. */
  verdict: requirementVerdictStatusSchema,
  /** The Tester's evidence for the verdict, when it gave any. */
  detail: v.nullable(v.string()),
  /** How many acceptance criteria the requirement carries in `spec/`. */
  criteriaCount: v.number(),
})
export type PrReportRequirement = v.InferOutput<typeof prReportRequirementSchema>

/**
 * The requirement → evidence section: every requirement in the service's in-repo `spec/`,
 * paired with the Tester's verdict on it.
 *
 * This is the capability the report was missing — it could say CI passed and the tester
 * greenlit, but not WHICH required behaviours were checked and what was observed, so a reviewer
 * could not tell a verified requirement from one nobody looked at.
 *
 * `absent` carries a `note` that distinguishes the reasons apart, because they call for
 * different reactions: no tester step at all, a tester that has not reported yet, a spec that
 * could not be read, and a spec with NO criteria recorded are four different states, and
 * collapsing them into one blank section is the false reassurance this report exists to remove.
 */
export const prReportRequirementsSchema = v.object({
  status: prReportSectionStatusSchema,
  /** Says WHY the section is empty when `status` is `absent` — never a bare blank. */
  note: v.optional(v.nullable(v.string())),
  /** Per-requirement rows (capped like every other list; see `truncations`). */
  entries: v.array(prReportRequirementSchema),
  /** Headline counts over the WHOLE spec, before any cap — so the table can be capped safely. */
  met: v.number(),
  notMet: v.number(),
  notCovered: v.number(),
  /**
   * REGRESSIONS: requirements the spec records as `established` that the Tester observed to
   * FAIL — a subset of {@link notMet}, and the only reading of this section that says the
   * change BROKE something rather than merely not finishing it.
   *
   * The distinction is what the implementation-state axis exists to make computable. A
   * `not_met` against an `aspirational` requirement is a behaviour that was agreed and is not
   * built yet, which is the normal state of in-flight work; a `not_met` against an
   * `established` one is behaviour the platform previously OBSERVED to hold and no longer
   * does. Both were reported as plain `not_met`, so a reviewer had to cross-reference two
   * columns of a capped table to tell "still building it" from "you broke the service" —
   * exactly the collapse `not_covered` was kept separate from `not_met` to prevent, one axis
   * over.
   *
   * Counted over the whole spec before any cap, and every regression row is guaranteed a place
   * in {@link entries} regardless of where the cap falls.
   */
  regressions: v.number(),
  /** Total requirements in the spec (`met + notMet + notCovered`). */
  total: v.number(),
})
export type PrReportRequirements = v.InferOutput<typeof prReportRequirementsSchema>

export const prVerificationReportSchema = v.object({
  /** See {@link PR_VERIFICATION_REPORT_VERSION}. */
  version: v.number(),
  /** Epoch ms the report was composed (refreshed on every publish). */
  generatedAt: v.number(),
  run: prReportRunSchema,
  ci: prReportCiSchema,
  tests: prReportTestsSchema,
  requirements: prReportRequirementsSchema,
  environments: prReportEnvironmentsSchema,
  merge: prReportMergeSchema,
  judges: prReportJudgesSchema,
  observability: prReportObservabilitySchema,
  /**
   * What the report had to leave out to stay inside a pull-request body, one human-readable
   * note per capped list (`"tests.outcomes: showing 50 of 118"`). Empty on any ordinary run.
   *
   * A capped list is only safe if it SAYS it was capped — "50 failing checks" and "50 of 118
   * failing checks" call for very different reviewer reactions, and the whole point of this
   * report is that a reader can trust what it shows to be the whole picture.
   */
  truncations: v.array(v.string()),
})
export type PrVerificationReport = v.InferOutput<typeof prVerificationReportSchema>

/**
 * Parse-or-throw a report payload — used by the conformance suite (and any external
 * consumer) to prove the JSON block the engine emitted is exactly this shape.
 */
export function parsePrVerificationReport(value: unknown): PrVerificationReport {
  return v.parse(prVerificationReportSchema, value)
}
