import type { Block } from './entities.js'
import type { PipelineStep } from './execution.js'
import type { RequirementPriority, RequirementState, SpecDoc } from './spec.js'
import type { RequirementVerdict, RequirementVerdictStatus, TestReport } from './testing.js'
import { UI_TESTER_AGENT_KIND } from './visual-pipeline.js'

// ---------------------------------------------------------------------------
// The rules for reading a RUN's evidence, stated once for every consumer that reduces it.
//
// A finished run is reduced twice today, for two audiences: the engine's PR verification report
// (what a reviewer needs to believe the change, written onto the pull request and served at
// `GET /api/v1/runs/:runId/report`) and the run OUTCOME summary (the non-code answer to "what
// did this run change", served at `GET /api/v1/runs/:runId/outcome` and rendered in the SPA).
// Two reductions is fine; two sets of RULES is not, and the second one had already drifted from
// the first in three places before this module existed:
//
//  - which tester step's verdicts count (the report unions every tester step, the summary read
//    only the last one that reported, so a pipeline carrying `tester-api` beside `tester-ui`
//    got different coverage on the two surfaces);
//  - what `not_covered` counts (the report enumerates the SPEC, so a requirement nobody looked
//    at is reported as unchecked; the summary enumerated the tester's own verdicts, so the same
//    requirement was invisible and both surfaces printed a number called "not covered");
//  - what a REGRESSION is (the same rule, written out twice);
//  - which BRANCH the spec is read from, the one that decides whether the join has anything to
//    match at all (see {@link runSpecBranch}).
//
// So the rules live here, in the package both the backend and the SPA compile against, and the
// two reductions call them rather than restating them. What each surface still owns is its own
// PRESENTATION and its own absence policy: the report withholds a section it cannot compute and
// says so in prose, the summary carries a machine-readable gap code the SPA maps to translated
// copy. Those genuinely differ. The facts underneath may not.
// ---------------------------------------------------------------------------

/** The API tester gate's agent kind. */
export const TESTER_AGENT_KIND = 'tester-api'

/**
 * Whether an agent kind is one of the tester gate kinds (API or UI).
 *
 * Here rather than in each consumer because every reduction of a run's test evidence starts by
 * answering it, and the two copies that preceded this one spelled the kinds out as literals on
 * one side and as constants on the other.
 */
export function isTesterKind(kind: string): boolean {
  return kind === TESTER_AGENT_KIND || kind === UI_TESTER_AGENT_KIND
}

/**
 * The step a section should report on: the LAST matching step that carries evidence, else the
 * first matching step.
 *
 * Last-with-evidence, not first-match: a pipeline may legitimately carry the same kind twice (a
 * `ci` gate after the coder and another after the tester), and the later run describes the head
 * as it stands now. Falling back to the first match rather than to nothing is what lets a
 * consumer tell "this pipeline has no such step" from "it has one and it has not reported yet",
 * which are opposite facts that a single `null` states identically.
 */
export function selectEvidenceStep(
  steps: readonly PipelineStep[],
  matches: (step: PipelineStep) => boolean,
  hasEvidence: (step: PipelineStep) => boolean,
): PipelineStep | undefined {
  const matching = steps.filter(matches)
  for (let i = matching.length - 1; i >= 0; i -= 1) {
    if (hasEvidence(matching[i]!)) return matching[i]
  }
  return matching[0]
}

/** Every tester step of a run, in pipeline order. */
export function testerSteps(steps: readonly PipelineStep[]): PipelineStep[] {
  return steps.filter((step) => isTesterKind(step.agentKind))
}

/**
 * The tester step whose report describes the work as it stands: the last one that reported,
 * else the first tester step in the pipeline (see {@link selectEvidenceStep}).
 */
export function selectTesterReportStep(steps: readonly PipelineStep[]): PipelineStep | undefined {
  return selectEvidenceStep(
    steps,
    (step) => isTesterKind(step.agentKind),
    (step) => step.test?.lastReport != null,
  )
}

/**
 * Index a run's requirement verdicts by the spec's own requirement id, across EVERY tester step
 * in pipeline order.
 *
 * Every tester step, not just the one whose report a `tests` section shows: a pipeline carrying
 * both `tester-api` and `tester-ui` promotes requirements off both kinds' verdicts, so a join
 * reading only the last of them shows "not checked" against requirements the spec already
 * records as `established`.
 *
 * A duplicate id keeps the FIRST verdict, whether it repeats within one report or across two
 * testers, because last-wins would let a trailing `not_covered` quietly erase a real
 * observation, which is the one thing a coverage join exists to prevent.
 */
export function indexRequirementVerdicts(
  steps: readonly PipelineStep[],
): Map<string, RequirementVerdict> {
  const byId = new Map<string, RequirementVerdict>()
  for (const step of testerSteps(steps)) {
    for (const verdict of step.test?.lastReport?.requirementVerdicts ?? []) {
      if (!byId.has(verdict.requirementId)) byId.set(verdict.requirementId, verdict)
    }
  }
  return byId
}

/**
 * One spec requirement paired with what the tester observed about it: the REQUIREMENT →
 * EVIDENCE row both reductions are built from.
 *
 * Deliberately un-scrubbed and un-clamped. A consumer writing onto a rendered surface (a pull
 * request body) owes the text its own boundary treatment, and doing it here would hand the SPA
 * escaped entities it has no reason to render.
 */
export interface JoinedRequirement {
  /** The spec requirement's stable id: the join key, and what a reader greps `spec/` for. */
  id: string
  title: string
  /** Where it lives in the spec taxonomy. */
  module: string
  group: string
  priority: RequirementPriority
  /**
   * Implementation state as `spec/` recorded it. It travels WITH the verdict because it is what
   * makes `not_met` readable: against an `aspirational` requirement that is in-flight work,
   * against an `established` one it is behaviour the service has lost.
   */
  state: RequirementState
  /** What the tester observed; `not_covered` when no tester ruled on it. */
  verdict: RequirementVerdictStatus
  /** The tester's evidence for the verdict, when it gave any. */
  detail: string | null
  /** How many acceptance criteria the requirement carries in `spec/`. */
  criteriaCount: number
}

/**
 * Join the service's in-repo `spec/` to a run's requirement verdicts, in spec order (module →
 * group → requirement).
 *
 * A requirement the tester said nothing about is `not_covered`, NEVER `not_met`: silence means
 * nobody looked, and rendering that as a failure would make every unrelated change look like it
 * broke the service.
 */
export function joinSpecRequirements(
  spec: SpecDoc,
  verdicts: ReadonlyMap<string, RequirementVerdict>,
): JoinedRequirement[] {
  const rows: JoinedRequirement[] = []
  for (const module of spec.modules ?? []) {
    for (const group of module.groups ?? []) {
      for (const requirement of group.requirements ?? []) {
        const verdict = verdicts.get(requirement.id)
        rows.push({
          id: requirement.id,
          title: requirement.title,
          module: module.name,
          group: group.name,
          priority: requirement.priority,
          state: requirement.state ?? 'aspirational',
          verdict: verdict?.status ?? 'not_covered',
          detail: verdict?.detail?.trim() || null,
          criteriaCount: (requirement.acceptance ?? []).length,
        })
      }
    }
  }
  return rows
}

/**
 * The verdict ids the join could NOT place: ids the tester ruled on that the spec does not
 * carry.
 *
 * Shared for the same reason the join is: the difference between a coverage section's rulings
 * and the tester's own is otherwise unexplainable, and it reads as a miscount in whichever of
 * the two the reader trusts less. Two spellings of "which ids went missing" would be a third
 * way for the two documents to print different numbers for one run.
 *
 * It is also the fact that tells an EMPTY join apart from an ABSENT one: a spec declaring no
 * requirements against a tester that ruled on nothing is genuinely nothing to report, while the
 * same spec against a tester that returned verdicts is a spec that moved on under the run, and
 * the verdicts are the only evidence there is.
 */
export function unmatchedVerdictIds(
  rows: readonly JoinedRequirement[],
  verdicts: ReadonlyMap<string, RequirementVerdict>,
): string[] {
  const known = new Set(rows.map((row) => row.id))
  return [...verdicts.keys()].filter((id) => !known.has(id))
}

/**
 * The branch a run's `spec/` must be read from: the branch the run pushed its work to, else the
 * repo's default.
 *
 * Stated here because THREE readers need the same answer and two of them had already disagreed:
 * the engine's evidence loader read the run's branch while the SPA's spec fetch read the default,
 * so an in-flight run's outcome card joined this run's verdicts against a spec that does not yet
 * carry the requirements it just ruled on. Every one of those rows lands as "not checked", and
 * the card's counts contradict `GET /api/v1/runs/:runId/outcome` for the same run.
 *
 * The run's branch, not the default, is the truthful denominator: the spec increment this task
 * wrote has not merged yet, and the verdicts were made against the tree as it stands on that
 * branch. Once the pull request merges the two answers converge, which is why the fallback is
 * the default branch rather than an absence.
 */
export function runSpecBranch(block: Block, defaultBranch: string): string {
  return block.pullRequest?.branch ?? defaultBranch
}

/**
 * Whether a row is a REGRESSION: behaviour the spec records as `established` (observed to hold
 * on some earlier run, which is the only thing that makes it standing behaviour) that this run's
 * tester observed to FAIL.
 *
 * The one derived fact the implementation-state axis exists to make computable, and the only
 * reading of a coverage section that says the change BROKE something rather than merely not
 * finishing it. Left uncomputed, an aspirational failure and a lost behaviour reach a reader as
 * the same `not met` cell.
 */
export function isRequirementRegression(row: {
  state: RequirementState
  verdict: RequirementVerdictStatus
}): boolean {
  return row.state === 'established' && row.verdict === 'not_met'
}

/** How many requirements landed on each verdict, over the WHOLE join and before any cap. */
export interface RequirementTally {
  met: number
  notMet: number
  notCovered: number
  /** A SUBSET of `notMet`: see {@link isRequirementRegression}. */
  regressions: number
  total: number
}

/**
 * Count a join. Over every row and before any cap, so a surface that shows a bounded table still
 * reports the true totals.
 */
export function tallyRequirements(rows: readonly JoinedRequirement[]): RequirementTally {
  const count = (status: RequirementVerdictStatus) =>
    rows.filter((row) => row.verdict === status).length
  return {
    met: count('met'),
    notMet: count('not_met'),
    notCovered: count('not_covered'),
    regressions: rows.filter(isRequirementRegression).length,
    total: rows.length,
  }
}

/** How the areas a tester exercised came out. */
export interface TestOutcomeTally {
  passed: number
  failed: number
  skipped: number
}

/** Tally a tester report's per-area outcomes. */
export function tallyTestOutcomes(report: TestReport): TestOutcomeTally {
  const tally: TestOutcomeTally = { passed: 0, failed: 0, skipped: 0 }
  for (const outcome of report.outcomes) tally[outcome.status] += 1
  return tally
}
