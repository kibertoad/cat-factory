import * as v from 'valibot'
import type { Block, PullRequestRef } from './entities.js'
import { allPullRequests } from './entities.js'
import type { EnvironmentStatus } from './environments.js'
import type { DeployEnvState, DisposeEnvState } from './deploy-envs.js'
import type { ExecutionInstance, PipelineStep } from './execution.js'
import { reproductionStatusSchema } from './reproduction.js'
import type { JoinedRequirement, RunEnvironmentObservation } from './run-evidence.js'
import {
  countCapturedViews,
  declaresRetainedEnvironment,
  deployedFrames,
  deployerSteps,
  disposedFrames,
  indexRequirementVerdicts,
  isEnvironmentGone,
  isRequirementRegression,
  isTesterKind,
  joinSpecRequirements,
  runEnvironmentObservations,
  selectTesterReportStep,
  tallyRequirements,
  tallyTestOutcomes,
  unmatchedVerdictIds,
} from './run-evidence.js'
import { documentFreshnessSchema, documentOriginSchema } from './documents.js'
import { requirementStateSchema } from './spec.js'
import type { ServiceSpecView } from './spec.js'
import { requirementVerdictStatusSchema, testConcernSeveritySchema } from './testing.js'
import { testEnvironmentSchema } from './testing.js'
import { UI_TESTER_AGENT_KIND } from './visual-pipeline.js'

// ---------------------------------------------------------------------------
// The RUN OUTCOME summary: the non-code answer to "what did this run change, and what backs
// that up".
//
// Reading a finished run used to mean reading a pull request: a branch name, a title, and a
// diff. Everything a person who does not read diffs needs was already captured (the tester's
// structured report, the screenshots it took, the visual-confirmation pairs a human reviewed,
// the per-requirement verdicts it returned) and each of those sat behind its own window, keyed
// by the STEP that produced it, so nobody who had not already learned the pipeline could find
// any of it. This module is the reduction that puts them in one place, keyed by the RUN.
//
// It lives in `@cat-factory/contracts` because it has THREE consumers that must agree: the SPA's
// outcome card, `GET /api/v1/runs/:runId/outcome`, and the engine's PR verification report, which
// reduces the same evidence for a reviewer. The first two are the same reduction and would be two
// copies of it anywhere else; the third is a different document, and the RULES it shares with
// this one (which tester steps count, what a regression is, how coverage is counted) live in
// `run-evidence.ts` so neither restates them. See that module's header for the three places the
// two had already drifted before it existed.
//
// Three rules shape what is here, and they are the reason it is a pure module rather than
// computation inside the window that renders it:
//
//  1. **Nothing here is asserted.** Every field is read off state a producer already recorded,
//     or COUNTED from it. The one derived judgement (a regression: an `established` requirement
//     the tester observed to fail) is computed in code from the spec's state and the tester's
//     verdict, so a reader can re-derive it from the rows. No model is asked for a headline.
//  2. **Absent and zero never render the same.** Every section is a discriminated union whose
//     `absent` arm carries a `gap` CODE (mapped to translated copy at the render site, never
//     prose from here), because "no tester ran" and "the tester found nothing wrong" are
//     opposite facts that a blank section states identically.
//  3. **The join to the spec is optional and says when it did not happen.** Coverage is counted
//     over the service's `spec/`, so a requirement nobody looked at is reported as unchecked
//     rather than being invisible; without the spec there is no such denominator, and
//     `spec: 'not_read'` says the ids the tester keyed its verdicts by are all there is rather
//     than letting an id read as the requirement's name.
//
// SINCE THIS SHAPE IS SERVED AT `GET /api/v1/runs/:runId/outcome`, it is part of the STABLE
// public surface: it grows by ADDITION (a new section, a new optional field, a new enum member)
// and never by renaming, retyping or removing in place.
// ---------------------------------------------------------------------------

/**
 * The wire version of the outcome payload. Bumped when the shape gains something an external
 * consumer would want to notice; never a compatibility switch (the surface is additive, so a
 * consumer written against an older number keeps reading the fields it knows).
 */
export const RUN_OUTCOME_VERSION = 3

/**
 * Where the run stands, in the terms the person reading the outcome cares about. Derived from
 * the BLOCK's status first (it is what the merge lifecycle writes) and from the run only for
 * the states a block cannot distinguish.
 */
export const outcomeDispositionSchema = v.picklist([
  'merged',
  'awaiting_merge',
  'in_flight',
  'needs_attention',
  'not_run',
  /**
   * The block names a run nobody resolved (see {@link runUnavailableGap}), and its status is
   * not one the merge lifecycle writes. What the run did is exactly the fact a block alone
   * cannot carry, and `not_run` would be this summary's most visible lie.
   */
  'unknown',
])
export type OutcomeDisposition = v.InferOutput<typeof outcomeDispositionSchema>

/** One pull request the run opened: the own-service PR, plus a peer PR per connected repo. */
export const outcomePullRequestSchema = v.object({
  url: v.string(),
  number: v.nullable(v.number()),
  branch: v.nullable(v.string()),
  /** `owner/name` for a PEER repo's PR; null for the task's own service. */
  repo: v.nullable(v.string()),
})
export type OutcomePullRequest = v.InferOutput<typeof outcomePullRequestSchema>

// ---- Requirement coverage --------------------------------------------------

/**
 * The gap EVERY evidence section shares: the block names a run (`block.executionId`) the
 * caller could not resolve, so nothing any step recorded is knowable here.
 *
 * It is kept apart from every other gap in this module, which report what a RESOLVED run did
 * or did not produce. "The store does not have this run" and "this pipeline has no tester
 * step" are opposite facts about opposite things, and a summary that reported the second for
 * the first would blame the pipeline for a read that never happened, on the one surface whose
 * whole job is to say what is known and what is not.
 */
export const runUnavailableGap = 'run_unavailable'
export type RunUnavailableGap = typeof runUnavailableGap

/** Why there is no requirement coverage to show. Each needs a different reaction. */
export const requirementsGapSchema = v.picklist([
  runUnavailableGap,
  'no_tester_step',
  'tester_not_reported',
  /** No spec to count against, and no verdict either: there is nothing at all to show. */
  'no_verdicts',
  /**
   * The spec WAS read, records no requirements, and no tester verdict stands against it either,
   * so there was nothing to rule on. A spec declaring nothing while the tester DID return
   * verdicts is a reported section instead, counting 0 requirements with every verdict
   * unmatched: those rulings are evidence, and calling them an absence would discard them.
   */
  'no_requirements',
])
export type RequirementsGap = v.InferOutput<typeof requirementsGapSchema>

/**
 * Whether the coverage was counted against the service's `spec/`, or only against the ids the
 * tester keyed its verdicts by.
 *
 * `joined` is the real answer: every requirement the service declares is a row, so one nobody
 * looked at is reported as unchecked. `not_read` is the degraded one, and it is a different
 * DENOMINATOR rather than a cosmetic loss of titles: the counts describe what the tester ruled
 * on and say nothing about what it skipped. It is a real state on both consumers (the SPA
 * renders before its spec fetch lands; a deployment with no VCS wired can never read one), so
 * it is stated rather than collapsed into an absence.
 */
export const outcomeSpecJoinSchema = v.picklist(['joined', 'not_read'])
export type OutcomeSpecJoin = v.InferOutput<typeof outcomeSpecJoinSchema>

/** One requirement, paired with what the tester observed about it. */
export const outcomeRequirementSchema = v.object({
  /** The spec requirement id: the join key, and all there is when the spec was not read. */
  id: v.string(),
  /** The requirement's headline from `spec/`; null on an unjoined row. */
  title: v.nullable(v.string()),
  verdict: requirementVerdictStatusSchema,
  /** What the tester observed, when it said. */
  detail: v.nullable(v.string()),
  /** Implementation state as `spec/` recorded it, or null when unjoined. */
  state: v.nullable(requirementStateSchema),
  /**
   * An `established` requirement the tester observed to FAIL: behaviour the platform had
   * previously seen hold and no longer does. Computed here, never read off a report, and the
   * one reading of this section that says the change BROKE something rather than merely not
   * finishing it. An `aspirational` requirement failing is in-flight work, not a regression.
   */
  regression: v.boolean(),
})
export type OutcomeRequirement = v.InferOutput<typeof outcomeRequirementSchema>

export const outcomeRequirementsSchema = v.variant('status', [
  v.object({ status: v.literal('absent'), gap: requirementsGapSchema }),
  v.object({
    status: v.literal('reported'),
    /** What the counts below are counted over. See {@link outcomeSpecJoinSchema}. */
    spec: outcomeSpecJoinSchema,
    met: v.number(),
    notMet: v.number(),
    notCovered: v.number(),
    /** A SUBSET of `notMet`; see {@link outcomeRequirementSchema.entries.regression}. */
    regressions: v.number(),
    /**
     * `met + notMet + notCovered`, and the DENOMINATOR the three are read against. Carried rather
     * than left to the reader to add up, because what it counts depends on `spec`: joined, it is
     * every requirement the service declares; unjoined, only the ones the tester ruled on.
     */
    total: v.number(),
    /**
     * Verdicts the tester returned against ids the spec does not carry, which the join can
     * neither place nor count. Non-zero means the spec moved on under the tester (or that it
     * keyed its verdicts by something else), and a reader comparing the totals to the tester's
     * own report needs to know the difference is not a miscount. Always 0 on a `not_read`
     * section, where there is nothing to match against.
     */
    unmatchedVerdicts: v.number(),
    /** Regressions first, then failures, then what was met, then what nobody checked. */
    entries: v.array(outcomeRequirementSchema),
  }),
])
export type OutcomeRequirements = v.InferOutput<typeof outcomeRequirementsSchema>

// ---- The tester's report ---------------------------------------------------

export const testsGapSchema = v.picklist([
  runUnavailableGap,
  'no_tester_step',
  'tester_not_reported',
])
export type TestsGap = v.InferOutput<typeof testsGapSchema>

/**
 * The tester's disposition. `could_not_run` is kept apart from `concerns` because they call
 * for opposite reactions: one is a change with bugs in it, the other is a change nobody
 * managed to exercise at all, and a report that collapses them reads as tested either way.
 */
export const testsVerdictSchema = v.picklist(['greenlit', 'concerns', 'could_not_run'])
export type TestsVerdict = v.InferOutput<typeof testsVerdictSchema>

export const outcomeConcernSchema = v.object({
  title: v.string(),
  severity: testConcernSeveritySchema,
})
export type OutcomeConcern = v.InferOutput<typeof outcomeConcernSchema>

export const outcomeTestsSchema = v.variant('status', [
  v.object({ status: v.literal('absent'), gap: testsGapSchema }),
  v.object({
    status: v.literal('reported'),
    verdict: testsVerdictSchema,
    /** The tester's own prose about the session, attributed as such at the render site. */
    summary: v.nullable(v.string()),
    /** Verbatim reason the tester could not run at all; null unless `could_not_run`. */
    abortReason: v.nullable(v.string()),
    /** What it exercised, by name. */
    areas: v.array(v.string()),
    passed: v.number(),
    failed: v.number(),
    skipped: v.number(),
    concerns: v.array(outcomeConcernSchema),
    environment: v.nullable(testEnvironmentSchema),
  }),
])
export type OutcomeTests = v.InferOutput<typeof outcomeTestsSchema>

// ---- What it looked like ---------------------------------------------------

export const visualsGapSchema = v.picklist([runUnavailableGap, 'no_visual_step', 'none_captured'])
export type VisualsGap = v.InferOutput<typeof visualsGapSchema>

/** One captured view, paired with the reference design it was reviewed against when there is one. */
export const outcomeVisualSchema = v.object({
  view: v.string(),
  artifactId: v.nullable(v.string()),
  referenceArtifactId: v.nullable(v.string()),
})
export type OutcomeVisual = v.InferOutput<typeof outcomeVisualSchema>

export const outcomeVisualsSchema = v.variant('status', [
  v.object({
    status: v.literal('absent'),
    gap: visualsGapSchema,
    /** The gate's own verbatim explanation, when it recorded one. Detail, never the headline. */
    detail: v.nullable(v.string()),
  }),
  v.object({
    status: v.literal('reported'),
    /**
     * Which producer the views came from. `visual_confirm` pairs were put in front of a
     * human and carry a verdict; `tester` shots are captures nobody was asked about, and the
     * summary must not let the second read as the first.
     */
    source: v.picklist(['visual_confirm', 'tester']),
    /** The gate's phase when the views came from it: awaiting a human, fixing, or approved. */
    phase: v.nullable(v.picklist(['awaiting_human', 'fixing', 'approved'])),
    views: v.array(outcomeVisualSchema),
  }),
])
export type OutcomeVisuals = v.InferOutput<typeof outcomeVisualsSchema>

// ---- Where to go and look --------------------------------------------------

/**
 * Why there is no environment to open. Each names a different reaction, and the last two are the
 * pair that matters: a pipeline that stands nothing up and one that was meant to and did not are
 * opposite facts about whether anything is missing.
 */
export const environmentsGapSchema = v.picklist([
  runUnavailableGap,
  /** Nothing in this pipeline provisions an environment, so there was never a URL to have. */
  'no_environment_step',
  /** Something was meant to stand one up and nothing was recorded: it has not got that far, or the deployment wires no environment provider. */
  'not_provisioned',
  /** Every frame the deployer settled declared no environment of its own (`infraless`). */
  'infraless',
])
export type EnvironmentsGap = v.InferOutput<typeof environmentsGapSchema>

/**
 * Where one environment stands, in the terms of the only question this section answers: is there
 * something to click, and if not, why not.
 *
 * Six members rather than the recorded lifecycle status alone, because the run's own reclaim is
 * part of the answer and the status projection cannot see it. `reclaimed` is deliberately the
 * one word for BOTH "the run's disposer tore it down" and "the disposer went looking and found
 * nothing live": who took it is not recorded anywhere this reduction can read, and the reader's
 * next move (start another run) is the same either way. `reclaiming` is kept apart from it
 * because a teardown that has been asked for is not one that happened.
 */
export const outcomeEnvironmentStateSchema = v.picklist([
  'live',
  'provisioning',
  'failed',
  'reclaiming',
  'reclaimed',
  'expired',
])
export type OutcomeEnvironmentState = v.InferOutput<typeof outcomeEnvironmentStateSchema>

/**
 * Which producer this row came from, so a consumer never reads one as another.
 *
 * `projected` is the in-flight row: the environment the run's steps are currently running
 * against, read off the step projection because no terminal per-frame outcome exists yet. It is
 * the weakest of the three and the only one that can still change, which is exactly why it is
 * labelled rather than folded into `deployer`.
 */
export const outcomeEnvironmentOriginSchema = v.picklist(['deployer', 'human_test', 'projected'])
export type OutcomeEnvironmentOrigin = v.InferOutput<typeof outcomeEnvironmentOriginSchema>

/** One environment this run stood up: where it is, where it stands, and how long it lasts. */
export const outcomeEnvironmentSchema = v.object({
  /** The public URL, or null when there is not one to open (still provisioning, or it failed). */
  url: v.nullable(v.string()),
  state: outcomeEnvironmentStateSchema,
  origin: outcomeEnvironmentOriginSchema,
  /**
   * Epoch ms the environment's TTL lapses, when the platform recorded one.
   *
   * A lapsed TTL is NOT folded into `state`: this reduction is clock-free on purpose, so the SPA
   * composing it live off its store and the endpoint composing it server-side cannot disagree
   * about the same run. What a reader gets instead is the instant itself, which says the same
   * thing without either surface having to guess whether the sweep has run yet.
   */
  expiresAt: v.nullable(v.number()),
  /**
   * True when the run's deployer DECLARED that the environments it provisions outlive the run.
   * It is what separates a preview URL a reviewer is meant to keep clicking from one that is
   * still standing because the reclaim never happened.
   */
  retained: v.boolean(),
  /** The service frame this environment was stood up for; null for a row no frame keys. */
  frameId: v.nullable(v.string()),
  /** The environments-registry id, the handle an operator greps for. Null when not recorded. */
  environmentId: v.nullable(v.string()),
  /** The producer's own verbatim cause, when it recorded one. Detail, never the headline. */
  detail: v.nullable(v.string()),
})
export type OutcomeEnvironment = v.InferOutput<typeof outcomeEnvironmentSchema>

export const outcomeEnvironmentsSchema = v.variant('status', [
  v.object({ status: v.literal('absent'), gap: environmentsGapSchema }),
  v.object({ status: v.literal('reported'), entries: v.array(outcomeEnvironmentSchema) }),
])
export type OutcomeEnvironments = v.InferOutput<typeof outcomeEnvironmentsSchema>

// ---- What it was built FROM ------------------------------------------------

/** Why there is no linked source to show. */
export const sourcesGapSchema = v.picklist([runUnavailableGap, 'none_linked'])
export type SourcesGap = v.InferOutput<typeof sourcesGapSchema>

/**
 * One linked document the run's agents read, reduced from the per-dispatch records its steps
 * carry.
 *
 * The verdict is the LAST one the run recorded, because that is the state it ended on. What a
 * last verdict cannot say is that the page moved WHILE the run was in flight, so that is carried
 * separately: a designer editing a frame mid-run leaves the early steps building against
 * something the late ones never read, and a row showing only the final revision reads as though
 * every step had it.
 */
export const outcomeSourceSchema = v.object({
  title: v.string(),
  /** Null for an `upload`, which has no source page to open. */
  url: v.nullable(v.string()),
  origin: documentOriginSchema,
  /** Null ⇒ this deployment ran no freshness check, which is not "checked and unsure". */
  freshness: v.nullable(documentFreshnessSchema),
  /**
   * True when the run's own steps recorded more than one distinct revision of this document.
   * Computed from the recorded verdicts, never asserted by a model.
   */
  movedDuringRun: v.boolean(),
})
export type OutcomeSource = v.InferOutput<typeof outcomeSourceSchema>

export const outcomeSourcesSchema = v.variant('status', [
  v.object({ status: v.literal('absent'), gap: sourcesGapSchema }),
  v.object({ status: v.literal('reported'), sources: v.array(outcomeSourceSchema) }),
])
export type OutcomeSources = v.InferOutput<typeof outcomeSourcesSchema>

// ---- The machine checks ----------------------------------------------------

/** The three recorded machine verdicts a non-code reader still needs: did it build, does it work. */
export const outcomeCheckKindSchema = v.picklist(['ci', 'validation', 'reproduction'])
export type OutcomeCheckKind = v.InferOutput<typeof outcomeCheckKindSchema>

export const outcomeCheckStateSchema = v.picklist(['pass', 'fail', 'pending', 'inconclusive'])
export type OutcomeCheckState = v.InferOutput<typeof outcomeCheckStateSchema>

export const outcomeCheckSchema = v.object({
  kind: outcomeCheckKindSchema,
  state: outcomeCheckStateSchema,
  /**
   * The producer's own qualifier, when the state alone would under-report it: the reproduction
   * verdict that earned an `inconclusive`. Rendered through an exhaustive map, never as prose.
   */
  reproduction: v.nullable(reproductionStatusSchema),
})
export type OutcomeCheck = v.InferOutput<typeof outcomeCheckSchema>

// ---- The whole summary -----------------------------------------------------

export const runOutcomeSchema = v.object({
  /** See {@link RUN_OUTCOME_VERSION}. */
  version: v.number(),
  disposition: outcomeDispositionSchema,
  /** The task's title: the product-language name of what was asked for. */
  title: v.string(),
  /** The requester's own description of the ask, trimmed; null when the task carried none. */
  ask: v.nullable(v.string()),
  /** Every PR the run opened, so the diff stays exactly one click from the summary. */
  pullRequests: v.array(outcomePullRequestSchema),
  requirements: outcomeRequirementsSchema,
  tests: outcomeTestsSchema,
  visuals: outcomeVisualsSchema,
  /**
   * The throwaway environments the run stood up, so "click and look" is one step from the
   * summary rather than buried in the step that provisioned it.
   */
  environments: outcomeEnvironmentsSchema,
  /** The linked pages the run built from, and how current the copy its agents read was. */
  sources: outcomeSourcesSchema,
  /** Only the checks that actually ran: an absent check is omitted, never rendered as passing. */
  checks: v.array(outcomeCheckSchema),
  /**
   * What a BOUNDED rendering of this summary had to leave out, one note per capped list
   * (`"requirements.entries: showing 200 of 480"`), in the same vocabulary the verification
   * report's own `truncations` uses. Empty whenever nothing was dropped, which is every
   * ordinary run and every composition the SPA does (it renders from state it already holds and
   * caps nothing).
   *
   * It exists because the counts above are computed over the WHOLE join, before any cap: a
   * consumer that found 200 rows under a `total` of 480 and no note would have to guess whether
   * the tail was never ruled on. A cap that is not a plain prefix says so in its note, since
   * `entries` is ordered by SEVERITY and the rows a cap drops are therefore the least severe
   * ones rather than the end of the spec.
   */
  truncations: v.array(v.string()),
})
export type RunOutcome = v.InferOutput<typeof runOutcomeSchema>

/**
 * Parse-or-throw an outcome payload, for any consumer proving the JSON it holds is this shape.
 */
export function parseRunOutcome(value: unknown): RunOutcome {
  return v.parse(runOutcomeSchema, value)
}

export interface ComposeRunOutcomeInput {
  block: Block
  /**
   * The run, or null when the caller has none. Null is TWO facts, and the block tells them
   * apart: a task with no `executionId` never ran, while a task that names one the caller
   * could not resolve has run and this summary simply cannot see it (see
   * {@link runUnavailableGap}). Callers pass what their store holds and never substitute one
   * for the other.
   */
  instance: ExecutionInstance | null
  /** The enclosing service's spec, when it has been loaded. Absent ⇒ ids without titles. */
  spec?: ServiceSpecView | null
}

/** Regressions first, then failures, then what held, then what nobody checked. */
const VERDICT_ORDER: Record<OutcomeRequirement['verdict'], number> = {
  not_met: 1,
  met: 2,
  not_covered: 3,
}

/** Project one joined row onto the summary's narrower row. */
function toOutcomeRequirement(row: JoinedRequirement): OutcomeRequirement {
  return {
    id: row.id,
    title: row.title,
    verdict: row.verdict,
    detail: row.detail,
    state: row.state,
    regression: isRequirementRegression(row),
  }
}

/** Severity first, then alphabetically by whatever the row can be named by. */
function bySeverity(a: OutcomeRequirement, b: OutcomeRequirement): number {
  if (a.regression !== b.regression) return a.regression ? -1 : 1
  const order = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]
  return order !== 0 ? order : (a.title ?? a.id).localeCompare(b.title ?? b.id)
}

function composeRequirements(
  steps: readonly PipelineStep[],
  spec: ServiceSpecView | null | undefined,
): OutcomeRequirements {
  const testers = steps.filter((step) => isTesterKind(step.agentKind))
  if (testers.length === 0) return { status: 'absent', gap: 'no_tester_step' }
  if (!testers.some((step) => step.test?.lastReport)) {
    return { status: 'absent', gap: 'tester_not_reported' }
  }

  // Every tester step's verdicts, not just the reporting one's: a pipeline carrying `tester-api`
  // beside `tester-ui` is ruled on by both, and this is the same index the PR verification
  // report joins against.
  const verdicts = indexRequirementVerdicts(steps)
  const doc = spec?.spec ?? null
  if (!doc) {
    // No denominator to count against. The rows are the tester's own verdicts, which is a
    // narrower statement than the joined section makes and is labelled as one.
    if (verdicts.size === 0) return { status: 'absent', gap: 'no_verdicts' }
    const entries = [...verdicts.values()]
      .map((verdict) => ({
        id: verdict.requirementId,
        title: null,
        verdict: verdict.status,
        detail: verdict.detail?.trim() || null,
        state: null,
        regression: false,
      }))
      .sort(bySeverity)
    return {
      status: 'reported',
      spec: 'not_read',
      met: entries.filter((e) => e.verdict === 'met').length,
      notMet: entries.filter((e) => e.verdict === 'not_met').length,
      notCovered: entries.filter((e) => e.verdict === 'not_covered').length,
      regressions: 0,
      total: entries.length,
      unmatchedVerdicts: 0,
      entries,
    }
  }

  const rows = joinSpecRequirements(doc, verdicts)
  const unmatched = unmatchedVerdictIds(rows, verdicts)
  // The spec was read and declares nothing, and no tester ruled on anything either: there is
  // genuinely no coverage to state. An empty join with verdicts standing against it is NOT this
  // case — it is a spec that moved on under the run, and reporting it as an absence would throw
  // away every ruling the tester made and claim there was nothing to rule on.
  if (rows.length === 0 && unmatched.length === 0) {
    return { status: 'absent', gap: 'no_requirements' }
  }
  const tally = tallyRequirements(rows)
  return {
    status: 'reported',
    spec: 'joined',
    ...tally,
    // A verdict the join could not place is REPORTED rather than dropped: it is the difference
    // between the tester's own count and this section's, and silence about it reads as a
    // miscount in whichever of the two the reader trusts less.
    unmatchedVerdicts: unmatched.length,
    entries: rows.map(toOutcomeRequirement).sort(bySeverity),
  }
}

function composeTests(step: PipelineStep | undefined): OutcomeTests {
  if (!step) return { status: 'absent', gap: 'no_tester_step' }
  const report = step.test?.lastReport
  if (!report) return { status: 'absent', gap: 'tester_not_reported' }

  const abortReason = report.abort?.reason?.trim() || null
  return {
    status: 'reported',
    verdict: abortReason ? 'could_not_run' : report.greenlight ? 'greenlit' : 'concerns',
    summary: report.summary?.trim() || null,
    abortReason,
    areas: [...report.tested],
    ...tallyTestOutcomes(report),
    concerns: report.concerns.map((concern) => ({
      title: concern.title,
      severity: concern.severity,
    })),
    environment: report.environment ?? null,
  }
}

function composeVisuals(
  steps: readonly PipelineStep[],
  tester: PipelineStep | undefined,
): OutcomeVisuals {
  // The visual-confirmation gate is preferred over the tester's raw captures: its pairs were
  // put in FRONT of a human and carry the reference they were judged against.
  //
  // Preferred only when it CAPTURED something, though. A gate row exists for any view either side
  // names, so a task whose linked designs (or hand-uploaded mocks) contributed references while
  // the run captured no screenshot has a full set of pairs and nothing to show of the change:
  // reporting that as this section's evidence would render a gallery of reference-only rows and
  // claim the run's visuals were verified. That is the "absent vs zero" line, so it falls through
  // to the absence below, which names the gate's own reason for the emptiness.
  const gate = steps.filter((s) => s.visualConfirm).at(-1)?.visualConfirm ?? null
  const gatePairs = gate?.pairs ?? []
  const pairs =
    countCapturedViews(gatePairs) > 0
      ? gatePairs.filter((p) => p.actualArtifactId || p.referenceArtifactId)
      : []
  if (pairs.length > 0) {
    return {
      status: 'reported',
      source: 'visual_confirm',
      phase: gate?.phase ?? null,
      views: pairs.map((p) => ({
        view: p.view,
        artifactId: p.actualArtifactId ?? null,
        referenceArtifactId: p.referenceArtifactId ?? null,
      })),
    }
  }

  const shots = tester?.test?.lastReport?.screenshots ?? []
  if (shots.length > 0) {
    return {
      status: 'reported',
      source: 'tester',
      phase: null,
      views: shots.map((s) => ({
        view: s.view,
        artifactId: s.artifactId,
        referenceArtifactId: s.referenceArtifactId ?? null,
      })),
    }
  }

  // Nothing to show: say whether anything was ever meant to capture a view. A gate that ran
  // and gathered nothing recorded WHY, and that reason is the whole answer for the reader.
  //
  // Asked of EVERY step, not of the tester whose report was selected: a pipeline can carry a
  // `tester-ui` that has not reported beside a `tester-api` that has, and the selected step is
  // then the api one. Reading the producer off it would tell a reader looking at a UI pipeline
  // that nothing in it captures the interface.
  const degraded = gate?.degradedReason?.trim() || null
  const hadProducer = Boolean(gate) || steps.some((s) => s.agentKind === UI_TESTER_AGENT_KIND)
  return {
    status: 'absent',
    gap: hadProducer ? 'none_captured' : 'no_visual_step',
    detail: degraded,
  }
}

/**
 * Reduce every dispatch's `contextDocuments` record into one row per linked page.
 *
 * The same reduction the PR verification report runs, over the same records, so the card a person
 * opens and the report a reviewer reads cannot disagree about which revision the run built from.
 * Order is first-read-first, so the list follows the run's own reading order.
 *
 * Rows are keyed by the document's SOURCE identity rather than by anything shown in them: an
 * `upload` carries no URL, so a key falling back to the title would fold two same-titled uploads
 * into one row and read their differing revisions as a page that moved mid-run.
 */
function composeSources(steps: readonly PipelineStep[]): OutcomeSources {
  const rows = new Map<string, OutcomeSource>()
  const revisions = new Map<string, Set<string>>()
  for (const step of steps) {
    for (const doc of step.contextDocuments ?? []) {
      const key = `${doc.origin}:${doc.externalId}`
      const seen = revisions.get(key) ?? new Set<string>()
      if (doc.freshness?.status === 'confirmed') seen.add(doc.freshness.version)
      revisions.set(key, seen)
      rows.set(key, {
        title: doc.title,
        url: doc.url || null,
        origin: doc.origin,
        freshness: doc.freshness ?? null,
        movedDuringRun: seen.size > 1,
      })
    }
  }
  if (rows.size === 0) return { status: 'absent', gap: 'none_linked' }
  return { status: 'reported', sources: [...rows.values()] }
}

/**
 * The recorded lifecycle status an environment carries, in the terms this section reports.
 * An exhaustive `Record`, so a new lifecycle member fails this build rather than rendering as a
 * blank row on the surface whose whole job is to say whether there is anything to click.
 */
const ENVIRONMENT_STATE_BY_STATUS: Record<EnvironmentStatus, OutcomeEnvironmentState> = {
  provisioning: 'provisioning',
  ready: 'live',
  failed: 'failed',
  expired: 'expired',
  tearing_down: 'reclaiming',
  torn_down: 'reclaimed',
}

/**
 * Where an environment stands as the run last OBSERVED it: the recorded lifecycle status, unless
 * a later deploy superseded the environment, which outranks whatever its last snapshot said.
 *
 * A superseded environment reports `reclaimed` for the same reason a disposer's `none` does: it
 * is gone, and who took it (the supersede's teardown, or its tombstone) is not recorded anywhere
 * this reduction can read. An already-terminal status is kept as it is, because `failed` and
 * `expired` name why it is gone and `reclaimed` would flatten that away.
 */
function observedState(observed: RunEnvironmentObservation): OutcomeEnvironmentState {
  if (observed.superseded && !isEnvironmentGone(observed.status)) return 'reclaimed'
  return ENVIRONMENT_STATE_BY_STATUS[observed.status]
}

/**
 * Where one frame's environment stands, from the three producers that know something about it,
 * in strict precedence.
 *
 * The DISPOSE record wins, because it is written after the run stops observing the environment:
 * a run's polls never revisit one once the run settles, so a reclaimed environment keeps a
 * `ready` observation forever. Below it the observation wins over the deployer's terminal row for
 * the mirror-image reason: the deploy row records the moment the environment came up and never
 * moves again, while the run's steps follow it for as long as one is watching. That is also
 * where the `human-test` gate's teardown enters, folded into the observation by identity: the
 * gate destroys the environment it sent a person to and stamps its own record, and this row is
 * for the same environment the deployer stood up.
 *
 * A reclaim that FAILED changes nothing here: the provider refused to tear the environment down,
 * so it is still standing and its URL still works. That it should not be is a fact about the
 * teardown proof (the PR verification report's business), not about whether a designer can open
 * it, and folding it in here would report a working preview as gone.
 */
function environmentState(
  deployed: DeployEnvState,
  disposal: DisposeEnvState | undefined,
  observed: RunEnvironmentObservation | undefined,
): OutcomeEnvironmentState {
  if (deployed.status === 'failed') return 'failed'
  // `none` means the disposer resolved this frame's environment and found nothing live: it is
  // gone, and the only thing separating that from a reclaim is who took it, which nothing
  // records. Reporting the deployer's terminal `ready` instead would hand out a dead URL.
  if (disposal && disposal.status !== 'failed') return 'reclaimed'
  if (observed) return observedState(observed)
  return 'live'
}

/**
 * The keys one row is claimed under: the environments-registry id, and the URL that names the
 * same environment for a producer that recorded no id.
 *
 * ONE definition, used by the join, the claim and the dedupe alike. The three previously spelled
 * identity differently (the join read the id, the claim wrote both, the gate leg checked only the
 * id), and every disagreement between them is a row that reads as a second environment or a row
 * joined to nothing at all.
 */
function environmentKeys(entry: { environmentId?: string | null; url?: string | null }): string[] {
  return [entry.environmentId, entry.url].filter((key): key is string => Boolean(key))
}

/**
 * Look one environment up the way a deploy row names it: by the id it recorded, else by the URL
 * it handed out.
 *
 * The URL leg is not a convenience. A deploy row predating `deployEnvs.environmentId` names its
 * environment ONLY by that URL, so an id-keyed lookup alone leaves such a row joined to nothing
 * while the observation carrying its real state sits one map away, and the row then reports the
 * `live` floor for an environment the run watched being torn down.
 */
function observationLookup(
  observations: readonly RunEnvironmentObservation[],
): (entry: {
  environmentId?: string | null
  url?: string | null
}) => RunEnvironmentObservation | undefined {
  const byId = new Map<string, RunEnvironmentObservation>()
  const byUrl = new Map<string, RunEnvironmentObservation>()
  for (const observed of observations) {
    byId.set(observed.id, observed)
    if (observed.url) byUrl.set(observed.url, observed)
  }
  return (entry) => {
    for (const key of environmentKeys(entry)) {
      const found = byId.get(key) ?? byUrl.get(key)
      if (found) return found
    }
    return undefined
  }
}

/**
 * The rows for the frames the run's deploys settled, beside the count of frames that declared no
 * environment at all.
 *
 * The `skipped` count travels with the rows rather than being derivable from them: a run whose
 * every frame is `infraless` stood nothing up ON PURPOSE, and reporting that as a deployer which
 * recorded nothing would send a reader looking for a provisioning failure that never happened.
 */
function deployedEnvironments(
  frames: ReadonlyMap<string, DeployEnvState>,
  disposed: ReadonlyMap<string, DisposeEnvState>,
  observationFor: ReturnType<typeof observationLookup>,
  retained: boolean,
): { entries: OutcomeEnvironment[]; skipped: number } {
  const entries: OutcomeEnvironment[] = []
  let skipped = 0
  for (const [frameId, deployed] of frames) {
    if (deployed.status === 'skipped') {
      skipped += 1
      continue
    }
    const observed = observationFor(deployed)
    const disposal = disposed.get(frameId)
    entries.push({
      url: deployed.url ?? observed?.url ?? null,
      state: environmentState(deployed, disposal, observed),
      origin: 'deployer',
      expiresAt: observed?.expiresAt ?? null,
      retained,
      // The observation's id where the frame recorded none: a frame that FAILED records only the
      // provider's cause, so without this the environment it broke on is nameless in the row that
      // is about it, and is then listed a second time as an environment no frame accounts for.
      frameId,
      environmentId: deployed.environmentId ?? observed?.id ?? null,
      // The provider's own note is the LAST fallback, after every recorded fault: it is the only
      // thing a frame settled against a still-building environment has, and a fault outranks it.
      detail:
        deployed.error ?? disposal?.error ?? observed?.lastError ?? observed?.statusNote ?? null,
    })
  }
  return { entries, skipped }
}

/**
 * The environments no settled frame accounts for: the one the run is running against right now
 * (no terminal frame row exists yet) and the one a `human-test` gate is holding for a person.
 *
 * Appended rather than folded into the deployer's rows, and LABELLED with the producer that
 * observed them. Without them the card goes silent for exactly as long as the run is live, which
 * is when a preview URL is most worth having.
 *
 * `claimed` carries what the deployer's rows already named, under the same keys everything else
 * here uses: listing one environment twice under two origins reads as two.
 */
function unclaimedEnvironments(
  observations: readonly RunEnvironmentObservation[],
  claimed: ReadonlySet<string>,
): OutcomeEnvironment[] {
  const seen = new Set(claimed)
  const entries: OutcomeEnvironment[] = []
  for (const observed of observations) {
    const keys = environmentKeys({ environmentId: observed.id, url: observed.url })
    if (keys.some((key) => seen.has(key))) continue
    for (const key of keys) seen.add(key)
    entries.push({
      url: observed.url,
      state: observedState(observed),
      origin: observed.source === 'human_test' ? 'human_test' : 'projected',
      expiresAt: observed.expiresAt,
      // The retention declaration is the deployer's, and this row is not one of its settled frames.
      retained: false,
      frameId: null,
      environmentId: observed.id,
      // These are the rows for environments no settled frame accounts for, and the commonest one
      // is the environment the run is standing up RIGHT NOW: it has no fault to report, and the
      // provider's note is the only thing that keeps the row from being a status and a URL.
      detail: observed.lastError ?? observed.statusNote,
    })
  }
  return entries
}

/**
 * The environments this run stood up.
 *
 * Composed from the run's own steps and nothing else, so the SPA's live composition and the
 * endpoint's answer for the same run are the same answer. That rules out the provisioning event
 * log, which is what DATES the lifecycle for the verification report; this section reports where
 * an environment stands, not when it got there, and the two surfaces share the rules they both
 * state through `run-evidence.ts` rather than sharing a read.
 *
 * Every deploy the run made is folded, not the last one alone: the frame rows report the
 * environment each frame ended on, and the ones an earlier deploy stood up are accounted for as
 * superseded rather than left to surface as a live preview nothing will refresh again.
 */
function composeEnvironments(steps: readonly PipelineStep[]): OutcomeEnvironments {
  const observations = runEnvironmentObservations(steps)
  if (deployerSteps(steps).length === 0 && observations.length === 0) {
    return { status: 'absent', gap: 'no_environment_step' }
  }
  const { entries, skipped } = deployedEnvironments(
    deployedFrames(steps),
    disposedFrames(steps),
    observationLookup(observations),
    declaresRetainedEnvironment(steps),
  )
  const claimed = new Set(entries.flatMap(environmentKeys))
  entries.push(...unclaimedEnvironments(observations, claimed))

  if (entries.length > 0) return { status: 'reported', entries }
  return { status: 'absent', gap: skipped > 0 ? 'infraless' : 'not_provisioned' }
}

function composeChecks(steps: readonly PipelineStep[]): OutcomeCheck[] {
  const checks: OutcomeCheck[] = []

  const ci = steps.filter((s) => s.agentKind === 'ci' && s.gate).at(-1)?.gate ?? null
  // A CI gate that has not probed yet has no verdict to report; `pending` is what the gate
  // itself records for "the checks are still running", so an unprobed gate is not folded onto it.
  if (ci?.lastVerdict) checks.push({ kind: 'ci', state: ci.lastVerdict, reproduction: null })

  const validation = steps.filter((s) => s.validation).at(-1)?.validation ?? null
  if (validation) {
    checks.push({
      kind: 'validation',
      state: validation.passed ? 'pass' : 'fail',
      reproduction: null,
    })
  }

  const reproduction = steps.filter((s) => s.reproduction).at(-1)?.reproduction ?? null
  if (reproduction) {
    // Only red-on-the-pre-fix-tree then green-on-the-final-tree is proof; every other verdict
    // is the absence of proof rather than a failure, which is why it is not a `fail`.
    checks.push({
      kind: 'reproduction',
      state: reproduction.status === 'reproduced' ? 'pass' : 'inconclusive',
      reproduction: reproduction.status,
    })
  }

  return checks
}

function composeDisposition(
  block: Block,
  instance: ExecutionInstance | null,
  unresolvedRun: boolean,
): OutcomeDisposition {
  if (block.status === 'done') return 'merged'
  if (block.status === 'pr_ready') return 'awaiting_merge'
  if (instance?.status === 'failed' || block.status === 'blocked') return 'needs_attention'
  // `in_progress` is the block's OWN word for a live run, so it stands whether or not the run
  // itself resolved: the one in-flight reading that needs nothing from the instance.
  if (instance || block.status === 'in_progress') return 'in_flight'
  return unresolvedRun ? 'unknown' : 'not_run'
}

function toOutcomePr(ref: PullRequestRef, repo: string | undefined): OutcomePullRequest {
  return {
    url: ref.url,
    number: ref.number ?? null,
    branch: ref.branch ?? null,
    repo: repo ?? null,
  }
}

/**
 * Compose a run's outcome summary from what the run already carries. Pure: every input is a
 * value the caller read off its store (the SPA) or off its repositories (the API), so the whole
 * reduction unit-tests without mounting the window that renders it, and the two surfaces cannot
 * answer the same question differently.
 */
export function composeRunOutcome({ block, instance, spec }: ComposeRunOutcomeInput): RunOutcome {
  const steps = instance?.steps ?? []
  // The block names a run the caller could not resolve. Everything below is read off that run's
  // steps, so composing from the empty list would report a pipeline that ran and produced
  // nothing, the exact misreading this summary exists to prevent (see `runUnavailableGap`).
  const unresolvedRun = !instance && Boolean(block.executionId)
  const asked = {
    version: RUN_OUTCOME_VERSION,
    disposition: composeDisposition(block, instance, unresolvedRun),
    title: block.title,
    ask: block.description?.trim() || null,
    // Read off the BLOCK, so they survive a run this summary cannot see: the pull request is
    // what a merged task is usually reopened for, long after its run left the store.
    pullRequests: allPullRequests(block).map(({ repo, ref }) => toOutcomePr(ref, repo)),
    // This composition caps nothing: it reduces state the caller already holds in full. A
    // consumer that BOUNDS the result for a wire fills this in and says what it dropped.
    truncations: [],
  }
  if (unresolvedRun) {
    return {
      ...asked,
      requirements: { status: 'absent', gap: runUnavailableGap },
      tests: { status: 'absent', gap: runUnavailableGap },
      visuals: { status: 'absent', gap: runUnavailableGap, detail: null },
      environments: { status: 'absent', gap: runUnavailableGap },
      sources: { status: 'absent', gap: runUnavailableGap },
      checks: [],
    }
  }
  // The tester step whose report describes the work as it stands: the same selection the PR
  // verification report's `tests` section makes, so the two never quote different sessions.
  const tester = selectTesterReportStep(steps)
  return {
    ...asked,
    requirements: composeRequirements(steps, spec),
    tests: composeTests(tester),
    visuals: composeVisuals(steps, tester),
    environments: composeEnvironments(steps),
    sources: composeSources(steps),
    checks: composeChecks(steps),
  }
}

/**
 * Whether a run has anything an outcome summary could show beyond the task's own title: a PR to
 * open, or a step that recorded evidence. EVERY entry point asks this (the board card and the
 * inspector alike, off the one reduction, so they can never disagree) so the affordance appears
 * on a run that produced something and stays absent on one that has not yet, rather than
 * offering a summary whose every section reads "nothing here".
 *
 * A run this summary could not resolve answers false unless the block still carries a pull
 * request: there is nothing to show, and an affordance that opened onto four "not loaded"
 * notices would be the same empty card by another route.
 *
 * Linked SOURCES deliberately do not count. They say what the run was working FROM, not what it
 * produced, so a run that has only read its brief has nothing for this card to answer yet. An
 * ENVIRONMENT does count, and is the one thing here that can be worth opening before the run has
 * produced anything else: a running preview of the change is exactly what the person who does
 * not read diffs came for.
 */
export function hasOutcomeToShow(outcome: RunOutcome): boolean {
  return (
    outcome.pullRequests.length > 0 ||
    outcome.requirements.status === 'reported' ||
    outcome.tests.status === 'reported' ||
    outcome.visuals.status === 'reported' ||
    outcome.environments.status === 'reported' ||
    outcome.checks.length > 0
  )
}
