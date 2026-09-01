import type { Block } from './entities.js'
import type { EnvironmentStatus } from './environments.js'
import type { DeployEnvState, DisposeEnvState } from './deploy-envs.js'
import type { PipelineStep } from './execution.js'
import type { VisualConfirmPair } from './human-verdict-gates.js'
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
 * The agent kind that PROVISIONS a run's ephemeral environments, the sole provisioner.
 * `pipeline-environment-lifecycle.ts` states its authoring rules relative to it and re-exports
 * it (see the note there for why the definition lives on this side).
 */
export const DEPLOYER_AGENT_KIND = 'deployer'

/**
 * The agent kind that REPAIRS a failed deployment: it clones the pull-request head, fixes the
 * deployment description there and pushes back onto the same branch, so the environment is stood
 * up again against the fix (the `ci-fixer` shape, one step earlier in the pipeline).
 *
 * It is dispatched ONLY for a failure classified `manifest_invalid`
 * (`isRepoFixableEnvironmentFailure`). That gate is not a refinement, it is the feature: every
 * other cause of a failed provision is something no edit in this checkout can address, and a
 * coding agent asked to address one anyway will hard-code the value the platform was supposed to
 * substitute, turn the run green, and hide the misconfiguration the failure was reporting.
 */
export const DEPLOY_FIXER_AGENT_KIND = 'deploy-fixer'

/**
 * The agent kind that RECLAIMS them again, the deployer's counterpart at the other end of the
 * lifecycle. It tears down by the environment ids the deployer RECORDED on its own step, so it
 * has nothing whatsoever to do without one earlier in the chain.
 */
export const DISPOSER_AGENT_KIND = 'disposer'

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

/**
 * How many of a visual-confirmation gate's pairs carry an ACTUAL capture: a screenshot this run
 * took of the running UI.
 *
 * The count that matters is never `pairs.length`, and the difference is the whole point. A pair
 * exists for any view either side of the comparison names, so a reference with nothing captured
 * against it makes one too: a mock someone uploaded, or a frame the task's linked design
 * contributed. Reading the row count as "screenshots" therefore turns a run that captured
 * NOTHING into one that captured several, and every consumer that asks the question gets the
 * same answer wrong in a different place: the gate drops the warning that gates its approve
 * button behind an acknowledgement, the outcome summary reports a verified gallery of blanks,
 * and the notification summoning the reviewer promises screenshots that are not there.
 *
 * So the rule is stated once, here, and the three of them call it. What a consumer does with the
 * answer stays its own: the gate words a degraded reason, the summary picks a gap code.
 */
export function countCapturedViews(pairs: readonly VisualConfirmPair[]): number {
  let captured = 0
  for (const pair of pairs) if (pair.actualArtifactId) captured += 1
  return captured
}

// ---- The run's ephemeral environments --------------------------------------
//
// A run that provisions throwaway infrastructure is read twice as well: the verification
// report proves the three-leg lifecycle (up, exercised, reclaimed) for a reviewer, and the
// outcome summary answers the one question a designer has, which is whether there is something
// standing to click. Both start from the same producers on the run's own steps, so which steps
// each is folded from, which recorded states mean the environment is gone, and how the
// observations of one environment are reconciled are stated here rather than on either side.

/** The lifecycle states that mean an environment is no longer standing. */
const GONE_ENVIRONMENT_STATUSES = new Set<EnvironmentStatus>(['torn_down', 'expired', 'failed'])

/**
 * Whether a recorded lifecycle status means the environment is no longer standing.
 *
 * `tearing_down` is deliberately NOT one of them: a teardown that has been asked for is not a
 * teardown that happened, and the two surfaces reading this need to keep them apart (the report
 * because an unfinished reclaim is not proof of one, the summary because it is a different thing
 * to tell a person than "it is gone").
 */
export function isEnvironmentGone(status: EnvironmentStatus): boolean {
  return GONE_ENVIRONMENT_STATUSES.has(status)
}

/** Every deployer step of a run, in pipeline order. */
export function deployerSteps(steps: readonly PipelineStep[]): PipelineStep[] {
  return steps.filter((step) => step.agentKind === DEPLOYER_AGENT_KIND)
}

/**
 * The per-frame deploy outcomes this run recorded, keyed by service-frame block id.
 *
 * Folded over EVERY deployer step rather than read off one of them, because a pipeline may
 * deploy more than once (a re-deploy after a fix, a `human-test` gate looping back to rebuild
 * the environment a person is testing), and a later deploy of the same frame WINS: it superseded
 * the earlier environment, so its row is the live one and the earlier id is a tombstone.
 *
 * That is the rule the disposer has always reclaimed by, and it is stated here because the two
 * evidence reductions read the same frames it tears down. Reading a single step instead drops
 * every frame the earlier deploys settled, which does not merely lose rows: the superseded
 * environment is then unaccounted for, and a summary that lists what no frame claims surfaces it
 * again as a live preview URL pointing at something the re-deploy already replaced.
 */
export function deployedFrames(steps: readonly PipelineStep[]): Map<string, DeployEnvState> {
  const byFrame = new Map<string, DeployEnvState>()
  for (const step of deployerSteps(steps)) {
    for (const [frameId, state] of Object.entries(step.deployEnvs ?? {}))
      byFrame.set(frameId, state)
  }
  return byFrame
}

/**
 * The per-frame reclaim outcomes this run recorded, the mirror of {@link deployedFrames} at the
 * other end of the lifecycle and folded the same way, for the same reason: a run that deployed
 * twice disposes twice.
 */
export function disposedFrames(steps: readonly PipelineStep[]): Map<string, DisposeEnvState> {
  const byFrame = new Map<string, DisposeEnvState>()
  for (const step of steps) {
    if (step.agentKind !== DISPOSER_AGENT_KIND) continue
    for (const [frameId, state] of Object.entries(step.disposeEnvs ?? {})) {
      byFrame.set(frameId, state)
    }
  }
  return byFrame
}

/**
 * Whether the run's deployer step DECLARED that the environments it provisions outlive the run
 * (`StepOptions.retainEnvironment`).
 *
 * Read off the step the run actually dispatched rather than off the pipeline definition, which
 * can be edited after the run started: every consumer of this is describing what THIS run did.
 * It is what separates an environment still standing because that was the point from one still
 * standing because the reclaim never happened, which is the difference between a preview URL a
 * reviewer is meant to keep clicking and a leak.
 */
export function declaresRetainedEnvironment(steps: readonly PipelineStep[]): boolean {
  return steps.some(
    (step) =>
      step.agentKind === DEPLOYER_AGENT_KIND && step.stepOptions?.retainEnvironment === true,
  )
}

/**
 * What one of the run's steps last saw of one environment: the id it names, where it was, and
 * the lifecycle status the observing step recorded.
 *
 * `source` travels with it because the two producers are not equally strong and a consumer must
 * never read one as the other. A `projection` is a poll's snapshot of a row the platform owns; a
 * `human_test` observation is the gate's record of the environment a PERSON was sent to, and its
 * `torn_down` is not a snapshot at all but the gate stating what IT did on the way past.
 */
export interface RunEnvironmentObservation {
  /** The environments-registry id: the identity every producer of this run agrees on. */
  id: string
  url: string | null
  status: EnvironmentStatus
  expiresAt: number | null
  /** The provider's own cause, where the observing producer recorded one. */
  lastError: string | null
  /**
   * The provider's own account of a state it has not left yet, where the observing producer
   * recorded one. Carried beside `lastError` rather than folded into it because the live
   * environment a run is still standing up is precisely the one with no cause to state: without
   * this, the row on the card that is about a spin-up in progress has nothing to say for exactly
   * as long as the spin-up takes.
   */
  statusNote: string | null
  source: 'projection' | 'human_test'
  /**
   * True when a LATER deploy of the same service frame replaced this environment.
   *
   * Derived rather than observed, and it has to be: a superseded environment is the one thing no
   * producer here ever revisits. The run's polls stop refreshing its projection the moment the
   * frame moves on, so it keeps whatever status it last had (usually `ready`) forever, while the
   * provisioning service has already torn it down or tombstoned its row on the way to standing
   * the replacement up. Left underived it is the most convincing dead link a run can produce: a
   * `ready` snapshot with a URL, of an environment nothing will ever refresh again.
   */
  superseded: boolean
}

/**
 * Whether an observation describes an environment that is no longer standing, by either route:
 * a recorded terminal status, or a later deploy having replaced it.
 *
 * The total form of {@link isEnvironmentGone} for a run's own observations, and the one both
 * reductions ask. Reading the status alone answers "was it torn down", which is a strictly
 * narrower question than "is it gone".
 */
export function isObservedEnvironmentGone(observed: RunEnvironmentObservation): boolean {
  return observed.superseded || isEnvironmentGone(observed.status)
}

/**
 * The environment identities an earlier deploy named that the run's CURRENT frame rows no longer
 * do: the ids and URLs a later deploy of the same frame superseded.
 *
 * Both keys, because the two are how the same environment is named by producers that recorded it
 * at different times: a deploy row predating `deployEnvs.environmentId` names its environment
 * only by the URL it handed out.
 */
function supersededEnvironmentKeys(steps: readonly PipelineStep[]): Set<string> {
  const live = new Set<string>()
  for (const state of deployedFrames(steps).values()) {
    if (state.environmentId) live.add(state.environmentId)
    if (state.url) live.add(state.url)
  }
  const superseded = new Set<string>()
  for (const step of deployerSteps(steps)) {
    for (const state of Object.values(step.deployEnvs ?? {})) {
      for (const key of [state.environmentId, state.url]) {
        if (key && !live.has(key)) superseded.add(key)
      }
    }
  }
  return superseded
}

/**
 * Narrow a producer's optional `expiresAt` / `lastError` / `statusNote` to the observation's
 * nullable shape.
 */
function observation(
  fields: {
    id: string
    url: string | null
    status: EnvironmentStatus
    expiresAt?: number | null
    lastError?: string | null
    statusNote?: string | null
  },
  source: RunEnvironmentObservation['source'],
  superseded: ReadonlySet<string>,
): RunEnvironmentObservation {
  return {
    id: fields.id,
    url: fields.url,
    status: fields.status,
    expiresAt: fields.expiresAt ?? null,
    lastError: fields.lastError ?? null,
    statusNote: fields.statusNote ?? null,
    source,
    superseded: superseded.has(fields.id) || (fields.url != null && superseded.has(fields.url)),
  }
}

/**
 * Everything the run's own steps observed about the environments it stood up: one row per
 * environment id, carrying the LAST observation of it, in the order the run first saw each one.
 *
 * Two producers write these and both have to be folded in, because they are the same
 * environments seen at different moments. A step PROJECTION (`step.environment`) is the weakest
 * signal there is: the run's polls write it and never refresh it once the run settles, so an
 * environment the TTL sweep reclaimed afterwards keeps a `ready` projection forever. The
 * `human-test` gate's own record (`step.humanTest.environment`) is written over the same
 * environment (the gate no longer provisions one: it READS what the deployer stood up), and on
 * the way past it stamps `torn_down` for the environment it destroyed when the person confirmed.
 *
 * Folding the two by IDENTITY, later-wins, is what makes that teardown visible. Kept apart, the
 * deployer's step projection still says `ready` for the same id, and a consumer that reads only
 * projections offers a link to an environment the gate destroyed. Kept as two lists, the same
 * environment appears twice under two producers, which reads as two.
 */
export function runEnvironmentObservations(
  steps: readonly PipelineStep[],
): RunEnvironmentObservation[] {
  const superseded = supersededEnvironmentKeys(steps)
  const byId = new Map<string, RunEnvironmentObservation>()
  for (const step of steps) {
    const projected = step.environment
    if (projected) byId.set(projected.id, observation(projected, 'projection', superseded))
    // After the projection, not before: the two never land on one step today (the gate is not an
    // env-projection kind), and where they ever do the gate's record is the later fact.
    const tested = step.humanTest?.environment
    if (tested) byId.set(tested.id, observation(tested, 'human_test', superseded))
  }
  return [...byId.values()]
}
