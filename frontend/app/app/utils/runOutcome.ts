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
// Three rules shape it, and they are the reason it is a pure module rather than computation
// inside the window:
//
//  1. **Nothing here is asserted.** Every field is read off state a producer already recorded,
//     or COUNTED from it. The one derived judgement (a regression: an `established` requirement
//     the tester observed to fail) is computed in code from the spec's state and the tester's
//     verdict, exactly as the PR verification report computes its own, so a reader can
//     re-derive it from the rows. No model is asked for a headline.
//  2. **Absent and zero never render the same.** Every section is a discriminated union whose
//     `absent` arm carries a `gap` CODE (mapped to translated copy at the render site, never
//     prose from here), because "no tester ran" and "the tester found nothing wrong" are
//     opposite facts that a blank section states identically.
//  3. **The join to the spec is optional and says when it did not happen.** Requirement
//     verdicts are keyed by the spec's own requirement id; without the service spec loaded
//     there is no title to show, so `spec: 'unavailable'` says the ids are all there is rather
//     than letting an id read as the requirement's name.
import type { Block, RequirementVerdictStatus, TestConcernSeverity } from '~/types/domain'
import type { ExecutionInstance, PipelineStep } from '~/types/execution'
import type { RequirementState, ServiceSpecView } from '~/types/spec'
import type { ReproductionStatus } from '~/types/reproduction'
import type { PullRequestRef, TestEnvironment } from '@cat-factory/contracts'
import { allPullRequests } from '@cat-factory/contracts'
import { isTesterKind } from '~/utils/catalog'

/**
 * Where the run stands, in the terms the person reading the outcome cares about. Derived from
 * the BLOCK's status first (it is what the merge lifecycle writes) and from the run only for
 * the states a block cannot distinguish.
 */
export type OutcomeDisposition =
  | 'merged'
  | 'awaiting_merge'
  | 'in_flight'
  | 'needs_attention'
  | 'not_run'
  /**
   * The block names a run nobody resolved (see {@link RunUnavailableGap}), and its status is
   * not one the merge lifecycle writes. What the run did is exactly the fact a block alone
   * cannot carry, and `not_run` would be this card's most visible lie.
   */
  | 'unknown'

/** One pull request the run opened: the own-service PR, plus a peer PR per connected repo. */
export interface OutcomePullRequest {
  url: string
  number: number | null
  branch: string | null
  /** `owner/name` for a PEER repo's PR; null for the task's own service. */
  repo: string | null
}

// ---- Requirement coverage --------------------------------------------------

/**
 * The gap EVERY evidence section shares: the block names a run (`block.executionId`) the
 * caller could not resolve, so nothing any step recorded is knowable here.
 *
 * It is kept apart from every other gap in this module, which report what a RESOLVED run did
 * or did not produce. "The store does not have this run" and "this pipeline has no tester
 * step" are opposite facts about opposite things, and a card that reported the second for the
 * first would blame the pipeline for a read that never happened, on the one surface whose
 * whole job is to say what is known and what is not.
 */
export type RunUnavailableGap = 'run_unavailable'

/** Why there is no requirement coverage to show. Each needs a different reaction. */
export type RequirementsGap =
  | RunUnavailableGap
  | 'no_tester_step'
  | 'tester_not_reported'
  | 'no_verdicts'

/**
 * Whether the requirement rows carry the spec's titles and, when they do not, WHY. The two
 * causes leave IDENTICAL rows behind and need different fixes, so they are never merged:
 * `not_read` is a spec this card never got (there was nothing to join against), `unmatched` is
 * a spec it DID read that holds none of the ids the tester reported (a spec rewritten since,
 * or a tester keying its verdicts by something else). Reporting the second as the first would
 * send a reader to fix a read that worked.
 */
export type OutcomeSpecJoin = 'joined' | 'not_read' | 'unmatched'

/** One requirement the tester ruled on, joined to the spec when the spec could be read. */
export interface OutcomeRequirement {
  /** The spec requirement id: the join key, and all there is when the join did not land. */
  id: string
  /**
   * The requirement's headline from `spec/`, or null when this id is not in the spec that was
   * read. Null on a row of an otherwise JOINED section is the partial-miss case the render
   * site marks per row: the id is all there is for THIS requirement, and left unmarked beside
   * its titled neighbours it reads as a requirement someone named after a slug.
   */
  title: string | null
  verdict: RequirementVerdictStatus
  /** What the tester observed, when it said. */
  detail: string | null
  /** Implementation state as `spec/` recorded it, or null when unjoined. */
  state: RequirementState | null
  /**
   * An `established` requirement the tester observed to FAIL: behaviour the platform had
   * previously seen hold and no longer does. Computed here, never read off the report, and the
   * one reading of this section that says the change BROKE something rather than merely not
   * finishing it. An `aspirational` requirement failing is in-flight work, not a regression.
   */
  regression: boolean
}

export type OutcomeRequirements =
  | { status: 'absent'; gap: RequirementsGap }
  | {
      status: 'reported'
      /** Whether the rows carry spec titles, or only the ids the tester keyed them by. */
      spec: OutcomeSpecJoin
      met: number
      notMet: number
      notCovered: number
      regressions: number
      /** Regressions first, then failures, then what was met, then what nobody checked. */
      entries: OutcomeRequirement[]
    }

// ---- The tester's report ---------------------------------------------------

export type TestsGap = RunUnavailableGap | 'no_tester_step' | 'tester_not_reported'

/**
 * The tester's disposition. `could_not_run` is kept apart from `concerns` because they call
 * for opposite reactions: one is a change with bugs in it, the other is a change nobody
 * managed to exercise at all, and a report that collapses them reads as tested either way.
 */
export type TestsVerdict = 'greenlit' | 'concerns' | 'could_not_run'

export interface OutcomeConcern {
  title: string
  severity: TestConcernSeverity
}

export type OutcomeTests =
  | { status: 'absent'; gap: TestsGap }
  | {
      status: 'reported'
      verdict: TestsVerdict
      /** The tester's own prose about the session, attributed as such at the render site. */
      summary: string | null
      /** Verbatim reason the tester could not run at all; null unless `could_not_run`. */
      abortReason: string | null
      /** What it exercised, by name. */
      areas: string[]
      passed: number
      failed: number
      skipped: number
      concerns: OutcomeConcern[]
      environment: TestEnvironment | null
    }

// ---- What it looked like ---------------------------------------------------

export type VisualsGap = RunUnavailableGap | 'no_visual_step' | 'none_captured'

/** One captured view, paired with the reference design it was reviewed against when there is one. */
export interface OutcomeVisual {
  view: string
  artifactId: string | null
  referenceArtifactId: string | null
}

export type OutcomeVisuals =
  | {
      status: 'absent'
      gap: VisualsGap
      /** The gate's own verbatim explanation, when it recorded one. Detail, never the headline. */
      detail: string | null
    }
  | {
      status: 'reported'
      /**
       * Which producer the views came from. `visual_confirm` pairs were put in front of a
       * human and carry a verdict; `tester` shots are captures nobody was asked about, and the
       * card must not let the second read as the first.
       */
      source: 'visual_confirm' | 'tester'
      /** The gate's phase when the views came from it: awaiting a human, fixing, or approved. */
      phase: 'awaiting_human' | 'fixing' | 'approved' | null
      views: OutcomeVisual[]
    }

// ---- The machine checks ----------------------------------------------------

/** The three recorded machine verdicts a non-code reader still needs: did it build, does it work. */
export type OutcomeCheckKind = 'ci' | 'validation' | 'reproduction'
export type OutcomeCheckState = 'pass' | 'fail' | 'pending' | 'inconclusive'

export interface OutcomeCheck {
  kind: OutcomeCheckKind
  state: OutcomeCheckState
  /**
   * The producer's own qualifier, when the state alone would under-report it: the reproduction
   * verdict that earned an `inconclusive`. Rendered through an exhaustive map, never as prose.
   */
  reproduction: ReproductionStatus | null
}

// ---- The whole summary -----------------------------------------------------

export interface RunOutcome {
  disposition: OutcomeDisposition
  /** The task's title: the product-language name of what was asked for. */
  title: string
  /** The requester's own description of the ask, trimmed; null when the task carried none. */
  ask: string | null
  /** Every PR the run opened, so the diff stays exactly one click from the summary. */
  pullRequests: OutcomePullRequest[]
  requirements: OutcomeRequirements
  tests: OutcomeTests
  visuals: OutcomeVisuals
  /** Only the checks that actually ran: an absent check is omitted, never rendered as passing. */
  checks: OutcomeCheck[]
}

export interface ComposeRunOutcomeInput {
  block: Block
  /**
   * The run, or null when the caller has none. Null is TWO facts, and the block tells them
   * apart: a task with no `executionId` never ran, while a task that names one the caller
   * could not resolve has run and this card simply cannot see it (see
   * {@link RunUnavailableGap}). Callers pass what their store holds and never substitute one
   * for the other.
   */
  instance: ExecutionInstance | null
  /** The enclosing service's spec, when it has been loaded. Absent ⇒ ids without titles. */
  spec?: ServiceSpecView | null
}

/**
 * The tester step whose report describes the PR as it stands: a pipeline may carry more than
 * one, and a later one supersedes an earlier one. Falls back to the first tester step so the
 * caller can tell "no tester in this pipeline" from "one is there and has not reported".
 */
function testerStep(steps: readonly PipelineStep[]): PipelineStep | null {
  const candidates = steps.filter((s) => isTesterKind(s.agentKind))
  const reported = candidates.filter((s) => s.test?.lastReport)
  return reported.at(-1) ?? candidates[0] ?? null
}

/** Index the service spec's requirements by id, for the verdict join. */
function specIndex(spec: ServiceSpecView | null | undefined) {
  const byId = new Map<string, { title: string; state: RequirementState }>()
  for (const module of spec?.spec?.modules ?? []) {
    for (const group of module.groups ?? []) {
      for (const req of group.requirements ?? []) {
        byId.set(req.id, { title: req.title, state: req.state ?? 'aspirational' })
      }
    }
  }
  return byId
}

/** Regressions first, then failures, then what held, then what nobody checked. */
const VERDICT_ORDER: Record<RequirementVerdictStatus, number> = {
  not_met: 1,
  met: 2,
  not_covered: 3,
}

/**
 * How the rows joined to the spec. Asked of the index rather than of the rows alone, because
 * "no titles" has two causes and only the index can tell them apart: an index with entries
 * that matched nothing is a spec that WAS read (see {@link OutcomeSpecJoin}).
 */
function specJoin(entries: readonly OutcomeRequirement[], specRead: boolean): OutcomeSpecJoin {
  if (entries.some((e) => e.title !== null)) return 'joined'
  return specRead ? 'unmatched' : 'not_read'
}

function composeRequirements(
  step: PipelineStep | null,
  spec: ServiceSpecView | null | undefined,
): OutcomeRequirements {
  if (!step) return { status: 'absent', gap: 'no_tester_step' }
  const report = step.test?.lastReport
  if (!report) return { status: 'absent', gap: 'tester_not_reported' }
  const verdicts = report.requirementVerdicts ?? []
  if (verdicts.length === 0) return { status: 'absent', gap: 'no_verdicts' }

  const index = specIndex(spec)
  const entries: OutcomeRequirement[] = verdicts.map((verdict) => {
    const known = index.get(verdict.requirementId)
    return {
      id: verdict.requirementId,
      title: known?.title ?? null,
      verdict: verdict.status,
      detail: verdict.detail?.trim() || null,
      state: known?.state ?? null,
      regression: known?.state === 'established' && verdict.status === 'not_met',
    }
  })
  entries.sort((a, b) => {
    if (a.regression !== b.regression) return a.regression ? -1 : 1
    const order = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]
    return order !== 0 ? order : (a.title ?? a.id).localeCompare(b.title ?? b.id)
  })

  return {
    status: 'reported',
    // A spec that resolved NO id says WHICH of the two reasons applies rather than reading as a
    // joined spec full of blank titles: the rows look the same either way and mean opposite
    // things about whether the reader is seeing everything.
    spec: specJoin(entries, spec?.spec != null),
    met: entries.filter((e) => e.verdict === 'met').length,
    notMet: entries.filter((e) => e.verdict === 'not_met').length,
    notCovered: entries.filter((e) => e.verdict === 'not_covered').length,
    regressions: entries.filter((e) => e.regression).length,
    entries,
  }
}

function composeTests(step: PipelineStep | null): OutcomeTests {
  if (!step) return { status: 'absent', gap: 'no_tester_step' }
  const report = step.test?.lastReport
  if (!report) return { status: 'absent', gap: 'tester_not_reported' }

  const abortReason = report.abort?.reason?.trim() || null
  const tally = { passed: 0, failed: 0, skipped: 0 }
  for (const outcome of report.outcomes) tally[outcome.status] += 1
  return {
    status: 'reported',
    verdict: abortReason ? 'could_not_run' : report.greenlight ? 'greenlit' : 'concerns',
    summary: report.summary?.trim() || null,
    abortReason,
    areas: report.tested,
    ...tally,
    concerns: report.concerns.map((c) => ({ title: c.title, severity: c.severity })),
    environment: report.environment ?? null,
  }
}

function composeVisuals(
  steps: readonly PipelineStep[],
  tester: PipelineStep | null,
): OutcomeVisuals {
  // The visual-confirmation gate is preferred over the tester's raw captures: its pairs were
  // put in FRONT of a human and carry the reference they were judged against.
  const gate = steps.filter((s) => s.visualConfirm).at(-1)?.visualConfirm ?? null
  const pairs = (gate?.pairs ?? []).filter((p) => p.actualArtifactId || p.referenceArtifactId)
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
  const hadProducer = Boolean(gate) || steps.some((s) => s.agentKind === 'tester-ui')
  return {
    status: 'absent',
    gap: hadProducer ? 'none_captured' : 'no_visual_step',
    detail: degraded,
  }
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
  // itself resolved — the one in-flight reading that needs nothing from the instance.
  if (instance || block.status === 'in_progress') return 'in_flight'
  return unresolvedRun ? 'unknown' : 'not_run'
}

/**
 * Compose a run's outcome summary from what the run already carries. Pure: every input is a
 * value the caller read off its store, so the whole reduction unit-tests without mounting the
 * window that renders it.
 */
export function composeRunOutcome({ block, instance, spec }: ComposeRunOutcomeInput): RunOutcome {
  const steps = instance?.steps ?? []
  const tester = testerStep(steps)
  // The block names a run the caller could not resolve. Everything below is read off that run's
  // steps, so composing from the empty list would report a pipeline that ran and produced
  // nothing — the exact misreading this card exists to prevent (see `RunUnavailableGap`).
  const unresolvedRun = !instance && Boolean(block.executionId)
  const asked = {
    disposition: composeDisposition(block, instance, unresolvedRun),
    title: block.title,
    ask: block.description?.trim() || null,
    // Read off the BLOCK, so they survive a run this card cannot see: the pull request is what
    // a merged task is usually reopened for, long after its run left the store.
    pullRequests: allPullRequests(block).map(({ repo, ref }) => toOutcomePr(ref, repo)),
  }
  if (unresolvedRun) {
    return {
      ...asked,
      requirements: { status: 'absent', gap: 'run_unavailable' },
      tests: { status: 'absent', gap: 'run_unavailable' },
      visuals: { status: 'absent', gap: 'run_unavailable', detail: null },
      checks: [],
    }
  }
  return {
    ...asked,
    requirements: composeRequirements(tester, spec),
    tests: composeTests(tester),
    visuals: composeVisuals(steps, tester),
    checks: composeChecks(steps),
  }
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
 * Whether a run has anything an outcome summary could show beyond the task's own title: a PR to
 * open, or a step that recorded evidence. EVERY entry point asks this (the board card and the
 * inspector alike, off the one reduction, so they can never disagree) so the affordance appears
 * on a run that produced something and stays absent on one that has not yet, rather than
 * offering a card whose every section reads "nothing here".
 *
 * A run this card could not resolve answers false unless the block still carries a pull
 * request: there is nothing to show, and an affordance that opened onto four "not loaded"
 * notices would be the same empty card by another route.
 */
export function hasOutcomeToShow(outcome: RunOutcome): boolean {
  return (
    outcome.pullRequests.length > 0 ||
    outcome.requirements.status === 'reported' ||
    outcome.tests.status === 'reported' ||
    outcome.visuals.status === 'reported' ||
    outcome.checks.length > 0
  )
}
