import * as v from 'valibot'
import { mergeAssessmentSchema } from './merge.js'
import { judgeDispositionSchema, judgeFindingSchema } from './judge.js'
import { requirementPrioritySchema, requirementStateSchema } from './spec.js'
import { reproductionStatusSchema } from './reproduction.js'
import { requirementVerdictStatusSchema, testEnvironmentSchema } from './testing.js'
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
//
// SINCE THIS SHAPE IS ALSO SERVED AT `GET /api/v1/runs/:runId/report`, it is part of the STABLE
// public surface: it grows by ADDITION (a new section, a new optional field, a new enum member)
// and never by renaming, retyping or removing in place. That is a tighter rule than the one this
// schema shipped under, and deliberately so: a consumer that was scraping the fenced block out
// of a PR body was already depending on it, and publishing the endpoint only made that
// dependency honest.
// ---------------------------------------------------------------------------

/**
 * The wire version of the report payload. Bumped when the shape gains something an external
 * consumer would want to notice.
 *
 * It is NOT a compatibility switch and never gates two shapes at once: the surface is additive
 * (see the header), so a bump means "there is more here than there was", and a consumer written
 * against an older number keeps reading the fields it knows.
 */
export const PR_VERIFICATION_REPORT_VERSION = 6

/**
 * How much of one captured command log the report carries, per command.
 *
 * Bounded here rather than left to the producer: the harness already trims each tail to what a
 * REPAIR PROMPT needs, and a pull-request body has a far tighter budget than a model's context
 * window — ten checks at the harness's own ceiling would blow {@link
 * hostMarkdown.MAX_SECTION_CHARS} on their own and cost the reader the whole machine-readable
 * block. The cut keeps the END of the log (where a failure is reported) and is recorded in the
 * report's `truncations`, so a shortened log never reads as a whole one.
 */
export const PR_REPORT_MAX_OUTPUT_CHARS = 2_000

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

// ---- Captured command output ----------------------------------------------
//
// The two sections below are the report's only CAPTURED-OUTPUT evidence: a command ran, and here
// is what it printed. Everything else in the report is a structured verdict somebody (a gate, a
// judge, an agent) produced; these two are the raw thing itself, which is why they are worth the
// body budget they cost. Both come off the step the harness wrote them onto — `step.validation`
// and `step.reproduction` — so neither re-runs anything at compose time.

/** One command's outcome in the run's pre-PR validation attempt. */
export const prReportValidationCommandSchema = v.object({
  /** The check's configured label (`lint`, `test`, `build`, …). */
  label: v.string(),
  /** The command line the harness ran in the checkout. */
  command: v.string(),
  /** Exit code (0 = pass); 124 on watchdog timeout, 127 on spawn failure. */
  exitCode: v.number(),
  passed: v.boolean(),
  /** Set when the command was killed by the per-command watchdog rather than exiting. */
  timedOut: v.optional(v.nullable(v.boolean())),
  durationMs: v.optional(v.nullable(v.number())),
  /**
   * The END of the command's combined stdout+stderr, secret-scrubbed and bounded to {@link
   * PR_REPORT_MAX_OUTPUT_CHARS}.
   *
   * Carried for a FAILING command only, and that is a stated rule rather than a silent one: a
   * green check's log is the one thing in this report a reviewer never acts on, and ten of them
   * would cost the body budget that makes the failing one readable. `null` on a passing row
   * therefore means "not retained", never "the command printed nothing" — the section says so in
   * as many words, because those two readings are exactly the kind of collapse this report exists
   * to remove.
   */
  outputTail: v.optional(v.nullable(v.string())),
})
export type PrReportValidationCommand = v.InferOutput<typeof prReportValidationCommandSchema>

/**
 * The PRE-PR VALIDATION section: the service's own check commands, run by the executor-harness
 * against the final checkout before the pull request was allowed to open, with their exit codes
 * and the captured output of whatever failed.
 *
 * This is the report's strongest single claim, because it is the one the platform ENFORCED: only
 * a green checkout opens a PR, so a `reported` + `passed` section says the commands in the table
 * below actually ran and actually exited 0 on this tree. It is deliberately distinct from the
 * `ci` section: CI is the host's verdict on the pushed branch (a different machine, later, and
 * for a red run possibly never), while this is the platform's own captured run of the service's
 * commands on the exact tree that was pushed.
 *
 * `absent` splits the causes that need different reactions, per the report's governing rule: a
 * service that configured no checks is a deployment gap, a step that never got that far is a run
 * outcome, and an older runner image that reports nothing is neither.
 */
export const prReportValidationSchema = v.object({
  status: prReportSectionStatusSchema,
  /** Says WHY the section is empty when `status` is `absent` — never a bare blank. */
  note: v.optional(v.nullable(v.string())),
  /** Whether every command in the recorded attempt exited 0 (⇒ the PR was allowed to open). */
  passed: v.optional(v.nullable(v.boolean())),
  /** The agent kind of the step that ran the checks, so a reader knows which dispatch this is. */
  stepKind: v.optional(v.nullable(v.string())),
  /** How many agent+check rounds ran, and the budget they ran under. */
  attempts: v.number(),
  maxAttempts: v.optional(v.nullable(v.number())),
  /** Epoch ms the recorded attempt finished. */
  at: v.optional(v.nullable(v.number())),
  /** Per-command outcomes of the recorded attempt (capped like every list; see `truncations`). */
  commands: v.array(prReportValidationCommandSchema),
})
export type PrReportValidation = v.InferOutput<typeof prReportValidationSchema>

/** One tree's run of the declared reproduction command (the pre-fix tree, or the final one). */
export const prReportReproductionPhaseSchema = v.object({
  exitCode: v.number(),
  passed: v.boolean(),
  durationMs: v.optional(v.nullable(v.number())),
  timedOut: v.optional(v.nullable(v.boolean())),
  /**
   * Set when this tree's SETUP command failed, so the check never ran meaningfully. Reported
   * rather than folded into a plain failure: a tree that could not be prepared says nothing about
   * the defect, and reading it as "red" is precisely the false `reproduced` the symmetric-worktree
   * design exists to prevent.
   */
  setupFailed: v.optional(v.nullable(v.boolean())),
  /** The END of the run's output, secret-scrubbed and bounded (see the validation twin). */
  outputTail: v.optional(v.nullable(v.string())),
})
export type PrReportReproductionPhase = v.InferOutput<typeof prReportReproductionPhaseSchema>

/**
 * The BUGFIX REPRODUCTION PROOF section: evidence that the declared reproducing check was RED on
 * the pre-fix tree and GREEN on the final one, which is the entire content of the claim "this
 * change fixes the bug" and the last big agent ASSERTION on a bugfix PR still taken on trust.
 *
 * `verdict` is computed by the harness from two exit codes, never self-reported by a model — the
 * `repro-test` kind's own `outcome` field has always been the model's claim, and this section is
 * what checks it. Three shapes reach a reviewer:
 *
 *  - `reproduced` — red at base, green at final, with both captured logs below.
 *  - `inconclusive` — anything else, stated plainly rather than dressed up. An ABSENT `final` is
 *    normal here: a green base already settles the verdict, so the second tree is not run.
 *  - `declared_infeasible` — the agent structurally declared reproduction impossible, with its
 *    reason and the alternative verification it performed. Nothing ran, so there are no phases.
 *
 * `observation` is the harness's own one-line diagnosis of an inconclusive shape and is rendered
 * VERBATIM. It is not interchangeable with re-deriving a cause from `base.passed`: a green base
 * can mean the test does not capture the defect, or that a resumed run's pre-fix tree already
 * carried this step's own interrupted work, and only the side that ran can tell those apart.
 */
export const prReportReproductionSchema = v.object({
  status: prReportSectionStatusSchema,
  /** Says WHY the section is empty when `status` is `absent` — never a bare blank. */
  note: v.optional(v.nullable(v.string())),
  /** The computed verdict. Null only when `status` is `absent`. */
  verdict: v.optional(v.nullable(reproductionStatusSchema)),
  /** The command run identically against both trees (empty for `declared_infeasible`). */
  command: v.optional(v.nullable(v.string())),
  /** The declared test files that constitute the reproduction. */
  testPaths: v.array(v.string()),
  /**
   * How many declared paths were DROPPED before the proof ran (unsafe, over-long, or over the
   * cap). Non-zero means the pre-fix tree was rebuilt from an incomplete reproduction, which can
   * green it and read as "the test does not capture the defect" — so it is stated rather than
   * implied.
   */
  omittedTestPaths: v.optional(v.nullable(v.number())),
  /** The pre-fix tree's run. Absent for `declared_infeasible`. */
  base: v.optional(v.nullable(prReportReproductionPhaseSchema)),
  /** The final tree's run. Absent for `declared_infeasible`, or when the base run settled it. */
  final: v.optional(v.nullable(prReportReproductionPhaseSchema)),
  /** How many agent+verify rounds ran, and the budget they ran under. */
  attempts: v.number(),
  maxAttempts: v.optional(v.nullable(v.number())),
  /** For `declared_infeasible`: WHY the bug could not be reproduced, verbatim from the agent. */
  reason: v.optional(v.nullable(v.string())),
  /** For `declared_infeasible`: what the agent verified INSTEAD, verbatim. */
  alternativeVerification: v.optional(v.nullable(v.string())),
  /** The producer's own one-line diagnosis of the observed shape. Rendered verbatim. */
  observation: v.optional(v.nullable(v.string())),
  /** Epoch ms the proof settled. */
  at: v.optional(v.nullable(v.number())),
})
export type PrReportReproduction = v.InferOutput<typeof prReportReproductionSchema>

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
 * Why the lifecycle could not be dated, as a MACHINE-READABLE cause rather than prose. The four
 * are kept apart because each is a different thing to fix, and because three of them would
 * otherwise be reported as the fourth: an empty timeline is what a deployment retaining no log,
 * a failed read, a truncated read and a run that stood nothing up all produce, and only one of
 * those is a statement about how the deployment is configured.
 *
 *  - `unwired`:         no provisioning-log repository is wired, so nothing records these dates.
 *  - `unreadable`:      the log is wired and the read FAILED. A transport blip, not a
 *                        configuration fact; re-attempted on the next publish.
 *  - `truncated`:       the run has more provisioning rows than one report read may take, so
 *                        what came back cannot be reasoned over as a complete history. Stated
 *                        rather than folded, because a partial history yields a CONFIDENT wrong
 *                        answer (an environment whose bring-up row fell off the end looks like
 *                        one that was never stood up, and therefore never needs reclaiming).
 *  - `not_provisioned`: the run has no deployer step, so no lifecycle was ever meant to exist
 *                        and the log was deliberately not queried.
 */
export const prReportTimelineGapSchema = v.picklist([
  'unwired',
  'unreadable',
  'truncated',
  'not_provisioned',
])
export type PrReportTimelineGap = v.InferOutput<typeof prReportTimelineGapSchema>

/**
 * The DATED half of the environment lifecycle, read off the run's rows in the provisioning
 * event log, the only store that records WHEN a throwaway environment came up and when it
 * went away. The step state can say an environment is gone; only the log can say it was torn
 * down at a time, by an attempt that succeeded.
 *
 * `gap` is the honest-absence flag and it is NOT a formality: a deployment that retains no
 * provisioning log, and one whose environments were never torn down, produce the same empty
 * timeline and opposite facts. Reporting either as `tornDownAt: null` alone would let a reader
 * conclude the environment is still running. It is a single field rather than a boolean beside
 * a reason, so the two can never disagree.
 */
export const prReportEnvironmentTimelineSchema = v.object({
  /**
   * Why this timeline is empty, or `null` when the log was read whole and the dates below are
   * the history. Non-null ⇒ every field below is a zero because nothing (or not enough) was
   * READ, not because nothing happened; `note` renders the same fact for a human.
   */
  gap: v.nullable(prReportTimelineGapSchema),
  /** Says why the timeline is empty when `gap` is set. */
  note: v.optional(v.nullable(v.string())),
  /** Epoch ms of the run's FIRST successful environment provision, when one is on record. */
  provisionedAt: v.nullable(v.number()),
  /**
   * Epoch ms of the run's LAST successful environment teardown, when one is on record. This is
   * the last one RECORDED, which is the end of the lifecycle only once {@link
   * prReportEnvironmentsSchema.entries.teardown} is `confirmed`: a run that replaced an
   * environment mid-flight reclaimed the superseded one and is still holding its replacement.
   */
  tornDownAt: v.nullable(v.number()),
  /**
   * How many provisioning attempts the log records as failures for this run (0 on a clean
   * bring-up). Counted at whatever grain the provider logged: a whole environment that failed to
   * come up, or one step of a multi-step stack recipe. Both are attempts that did not work, and
   * the log does not distinguish them, so neither does this.
   */
  provisionFailures: v.number(),
  /**
   * How many environments the run stood up whose LATEST teardown attempt failed. A non-zero
   * count is the state the live-projection tri-state below cannot express: the platform tried to
   * reclaim the environment and the provider refused, which is an operator's problem rather than
   * a run's. Counted per environment, not per attempt, so a retry loop against one stuck
   * environment does not read as a fleet of them.
   */
  teardownFailures: v.number(),
})
export type PrReportEnvironmentTimeline = v.InferOutput<typeof prReportEnvironmentTimelineSchema>

/** One artifact the UI tester captured while exercising the live environment. */
export const prReportEvidenceArtifactSchema = v.object({
  /** The logical view the screenshot was taken of. */
  view: v.string(),
  /** The stored artifact id, in the deployment's binary-artifact store. */
  artifactId: v.string(),
  /** Whether a reference design image was paired with it for visual confirmation. */
  hasReference: v.boolean(),
  /**
   * Direct link to the artifact's BYTES, on the deployment's own authenticated blob endpoint —
   * the thing a reviewer (or a downstream tool holding an API key) actually wants from a row that
   * used to carry an opaque id and nothing else.
   *
   * Deliberately the API URL rather than the app deep link beside it on the section: the deep link
   * lands a human in the run's evidence panel, which is the right place to BROWSE, and is useless
   * to anything that is not a browser with a session. Both are emitted because they answer
   * different questions, and neither substitutes for the other.
   *
   * Null when the deployment configured no public backend URL, so the report never emits a link to
   * nowhere; the `artifactId` is still there, which is what an operator greps the store for.
   */
  url: v.nullable(v.string()),
})
export type PrReportEvidenceArtifact = v.InferOutput<typeof prReportEvidenceArtifactSchema>

/**
 * The MIDDLE leg of the lifecycle proof: what was actually observed against the environment
 * while it was live. An environment that came up and was torn down again proves only that the
 * platform can spin infrastructure; it becomes evidence for the CHANGE when something was
 * exercised against it in between.
 *
 * The four statuses are kept apart because they call for different reactions:
 *  - `captured`:   a tester ran against the ephemeral environment and its observations are below.
 *  - `local`:      a tester ran, but against locally stood-up dependencies, so nothing was
 *                   observed against the environment this section is about.
 *  - `undeclared`: a tester reported without saying where it ran, so its observations cannot be
 *                   ATTRIBUTED to this environment. Distinct from `local`, which is a positive
 *                   statement that it ran somewhere else; guessing either way would turn an
 *                   unknown into a claim, in the one section whose whole job is provenance.
 *  - `absent`:     no tester report at all (no tester step, or it never settled).
 *
 * The artifacts and counts are reported WHATEVER the status: they exist, and a reviewer should
 * be able to reach them. What the status governs is whether they may be read as evidence about
 * this environment, which is why the attribution rides the section rather than the rows.
 */
export const prReportEnvironmentEvidenceSchema = v.object({
  status: v.picklist(['captured', 'local', 'undeclared', 'absent']),
  /** Says why the observations below are not evidence about this environment. */
  note: v.optional(v.nullable(v.string())),
  /** Where the tester stood the system under test up, when a report says. */
  ranAgainst: v.nullable(testEnvironmentSchema),
  /** Epoch ms the tester step settled: the observation's place on the timeline above. */
  capturedAt: v.nullable(v.number()),
  /** How many areas the tester reported an outcome for. */
  outcomes: v.number(),
  /** How many spec requirements it returned a verdict on. */
  requirementVerdicts: v.number(),
  /** The screenshots it captured (capped like every other list; see `truncations`). */
  screenshots: v.array(prReportEvidenceArtifactSchema),
  /**
   * Deep link into the run's captured evidence in the app. Null when the deployment configured
   * no public app URL, so the report never emits a link to nowhere. The rows above still name
   * each artifact, which is what an operator greps the store for.
   */
  url: v.nullable(v.string()),
})
export type PrReportEnvironmentEvidence = v.InferOutput<typeof prReportEnvironmentEvidenceSchema>

/**
 * The ephemeral-environment lifecycle, as the three-leg proof a reviewer needs: the
 * environment came UP, evidence was CAPTURED from it while it was live, and it was TORN DOWN
 * again. Each leg is a captured fact from a different producer, and `proof` is COMPUTED from
 * the three in code, never read off any agent's claim that it tested against a preview.
 *
 * `teardown` prefers the provisioning log's RECORDED attempts, per environment identity, and
 * falls back to the run's live step projection only when there is no log to read:
 *  - `confirmed`      — every environment the run stood up was reclaimed.
 *  - `pending`        — at least one is still standing (the run may still be using it).
 *  - `failed`         — an environment's latest teardown attempt FAILED, so it is still standing
 *                       for a reason someone has to act on.
 *  - `not_applicable` — nothing was ever provisioned.
 */
export const prReportEnvironmentsSchema = v.object({
  status: prReportSectionStatusSchema,
  note: v.optional(v.nullable(v.string())),
  entries: v.array(prReportEnvironmentSchema),
  teardown: v.picklist(['confirmed', 'pending', 'failed', 'not_applicable']),
  timeline: prReportEnvironmentTimelineSchema,
  evidence: prReportEnvironmentEvidenceSchema,
  /**
   * The composed verdict over the three legs:
   *  - `complete`:       up, observed, and reclaimed.
   *  - `incomplete`:     at least one leg is missing; {@link gaps} names which.
   *  - `not_applicable`: no environment was ever meant to stand up (no deployer step, or every
   *                       frame is infraless), so there is nothing to prove.
   *
   * COMPUTED from the legs, never asserted: this is the platform's judgement about its own
   * evidence, and a reviewer must be able to re-derive it from the rows above.
   */
  proof: v.picklist(['complete', 'incomplete', 'not_applicable']),
  /**
   * One human-readable line per missing or contradictory leg, so an `incomplete` proof always
   * says WHAT is missing rather than leaving a reader to diff the sections. Empty when
   * `proof` is `complete`.
   */
  gaps: v.array(v.string()),
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
 * Where the evidence behind this report can be inspected, one link per AUDIENCE.
 *
 * `runUrl` is for a person: the run's observability panel (Model activity / Provided context),
 * built from the deployment's public app URL (`appBaseUrl`). The other two are for a machine
 * and are built from the deployment's public BACKEND url (`apiBaseUrl`), the same config the
 * artifact byte links use. The two coincide on a same-origin deployment and diverge the moment
 * the SPA is served from its own host, and a link built from the wrong one is worse than none.
 *
 * Each is null when its base URL is unconfigured, so the report never emits a link to nowhere.
 */
export const prReportObservabilitySchema = v.object({
  runUrl: v.nullable(v.string()),
  /**
   * The run's TOOL-CALL TRAJECTORY: what its agents did, in the order they did it, ordered
   * server-side and returned whole.
   *
   * This is the link that makes the report auditable rather than merely informative. Every
   * other section is a verdict somebody produced; the trajectory is the record of the work
   * those verdicts are about, and until it was named here a reader who wanted it had to know
   * both that the debug API exists and how to address a run on it.
   */
  trajectoryUrl: v.nullable(v.string()),
  /**
   * THIS report, served live as JSON. What the fenced block below carries is a snapshot taken
   * when the report was last published; a consumer that wants the current one (or that is
   * reading a run whose PR body it does not have) fetches it here.
   */
  reportUrl: v.nullable(v.string()),
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
   * Counted over the whole spec before any cap, so this is the true total even when
   * {@link entries} is capped. Regression rows are selected into `entries` AHEAD of every other
   * row — priority, not a guarantee: a spec with more regressions than the row budget still
   * loses some, and the `truncations` log says how many fit.
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
  /** The platform's OWN run of the service's check commands against the pushed tree. */
  validation: prReportValidationSchema,
  /** Red-on-the-pre-fix-tree, green-on-the-final-tree evidence for a bugfix run. */
  reproduction: prReportReproductionSchema,
  tests: prReportTestsSchema,
  requirements: prReportRequirementsSchema,
  environments: prReportEnvironmentsSchema,
  merge: prReportMergeSchema,
  judges: prReportJudgesSchema,
  observability: prReportObservabilitySchema,
  /**
   * What the report had to leave out to stay inside a pull-request body, one human-readable
   * note per capped list (`"tests.outcomes: showing 50 of 118"`). A list whose cap is not a
   * plain prefix adds a parenthetical saying so, since a reader who assumes the first N would
   * conclude the tail was never ruled on. Empty on any ordinary run.
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
