import { type IntegrationTestOutcome, integrationTestOutcome } from '@cat-factory/agents'
import { renderStructuredDigest } from './structuredDigest.logic.js'

// Pure rendering for the `integration-test` post-completion resolver: fold its STRUCTURED outcome
// (`result.custom`, the `integrationTestOutcome` schema) into a short prose digest that lands on
// `step.output`. Downstream steps read only `step.output` via `priorOutputs`, so this digest is how
// the coverage verdict reaches the merger (which weighs it in the merge assessment) and a human at
// the merge gate; the raw structured object stays on `step.custom` for the `generic-structured`
// result view. Returns `undefined` for an unparseable/empty result, so the resolver leaves the
// agent's raw reply on `step.output`.
//
// Everything here reads the RECORD, never a live job: the same `step.custom` the pull-request
// report and the run outcome summary read, so the three cannot describe one run in three ways.

/**
 * Human-readable heading for each coverage outcome, typed over the closed picklist so the lookup
 * is total and the compiler refuses a new verdict until it has a heading.
 */
const OUTCOME_LABEL: Record<IntegrationTestOutcome['outcome'], string> = {
  covered: 'Covered by committed tests',
  partial: 'Partially covered',
  uncovered: 'Not covered: no test was committed',
}

/**
 * What the platform stands behind, having read the step's own claim against whether the run
 * committed anything (`committed`, computed at the result boundary; see the field's contract).
 *
 * `claimed` is kept beside `effective` rather than replaced by it. Which verdict the step ASSERTED
 * is the whole content of the discrepancy, and a reader shown only the corrected value learns that
 * nothing was covered without learning that something said otherwise.
 */
interface CoverageVerdict {
  claimed: IntegrationTestOutcome['outcome']
  effective: IntegrationTestOutcome['outcome']
  /** True when `effective` was derived DOWN from `claimed` because the run committed nothing. */
  contradicted: boolean
}

/**
 * Read a coverage claim against the commits behind it.
 *
 * A run that pushed nothing added no test files, whatever it reported, so its effective coverage
 * is `uncovered` and the claim is named as a claim. That is the platform COMPUTING rather than
 * quoting: there is no equivalent of the reproduction step's platform-run command here, and this
 * is the one check available. `committed: undefined` (the harness reported no push outcome) is
 * unknown, not false, so it corrects nothing.
 */
function coverageVerdict(parsed: IntegrationTestOutcome): CoverageVerdict {
  const contradicted = parsed.committed === false && parsed.outcome !== 'uncovered'
  return {
    claimed: parsed.outcome,
    effective: contradicted ? 'uncovered' : parsed.outcome,
    contradicted,
  }
}

/** The platform's line about a claim its own record contradicts, or nothing to say. */
function contradictionCaveat(verdict: CoverageVerdict): string | undefined {
  if (!verdict.contradicted) return undefined
  return (
    `The step reported "${OUTCOME_LABEL[verdict.claimed]}", but this run pushed no files, so it ` +
    'committed no tests. Anything it named below is either already in the repository or was ' +
    'never written; treat the change as uncovered by this step.'
  )
}

/**
 * Render an integration-test step's structured outcome into a human-readable digest, or
 * `undefined`.
 *
 * The `Not covered` section is rendered whenever the agent named a gap, INCLUDING under a
 * `covered` verdict: the two are not in tension (the reported behaviour can be covered while a
 * neighbouring case is not), and a gap the reply stated is the one thing a reader cannot recover
 * from anywhere else. Dropping it under a green heading is how "covered" comes to mean more than
 * the step ever claimed.
 */
export function renderIntegrationTestDigest(custom: unknown): string | undefined {
  const parsed = integrationTestOutcome.safeParse(custom)
  if (!parsed) return undefined
  const verdict = coverageVerdict(parsed)
  return renderStructuredDigest({
    heading: 'Integration tests',
    headline: OUTCOME_LABEL[verdict.effective],
    caveats: [contradictionCaveat(verdict)],
    sections: [
      // Named rather than "Tests" when the claim is contradicted: the paths are still worth
      // showing (they say where the step believed the coverage was) but calling them this run's
      // tests would restate the claim the heading above just withdrew.
      {
        heading: verdict.contradicted ? 'Tests the step named' : 'Tests',
        values: parsed.testPaths,
        code: true,
      },
      { heading: 'Test doubles', values: parsed.mocks, code: true },
      { heading: 'Not covered', values: parsed.uncovered },
    ],
    notes: parsed.notes,
  })
}

/**
 * The `tests` section's absent NOTE for a run with no tester step but an `integration-test` step
 * that reported, or `undefined` when this run has nothing of the sort to report.
 *
 * It exists because the plain no-tester note ("no test run was performed by the platform") is a
 * claim, not an absence, and on `pl_bugfix_tested` it is usually the wrong one: a suite ran, and
 * the tests it ran are in the diff the reviewer is reading. A reviewer told only that no tester ran
 * concludes the change is unverified, which is the exact misreading the report exists to prevent.
 *
 * "Usually", which is why the note BRANCHES on what the step actually reported rather than opening
 * with the verification claim every time. A step that committed nothing (its own `uncovered`, the
 * value an unparseable reply also degrades to, or a `covered` the commits contradict) leaves the
 * change exactly as unexercised as no step at all, and saying otherwise over it would be a
 * stronger overclaim than the line this replaced.
 *
 * The counts are COMPUTED from the step's own stated lists rather than read off a claim, and the
 * note carries no model-authored prose, so it stays an engine statement about the run: which is
 * what lets it be interpolated into the rendered section like every other note.
 *
 * @param custom the `integration-test` step's structured outcome
 * @param hasCiGate whether the run carries an enabled `ci` gate. The sentence naming CI as what
 *   runs the committed tests is the enforcement half of the claim, and a pipeline is free to carry
 *   this step without that gate: promising a check that will never run is the same defect as
 *   claiming a test run that never happened.
 */
export function integrationTestVerificationNote(
  custom: unknown,
  hasCiGate: boolean,
): string | undefined {
  const parsed = integrationTestOutcome.safeParse(custom)
  if (!parsed) return undefined
  const verdict = coverageVerdict(parsed)
  const tests = parsed.testPaths.filter((path) => path.trim().length > 0).length
  const gaps = parsed.uncovered.filter((gap) => gap.trim().length > 0).length
  const counts = [
    `${tests} test ${tests === 1 ? 'file' : 'files'}`,
    `${gaps} stated ${gaps === 1 ? 'gap' : 'gaps'}`,
  ].join(', ')
  const opening =
    verdict.effective === 'uncovered'
      ? 'No tester step in this pipeline, and the integration-test step that stands in for one ' +
        'committed no coverage, so nothing here was exercised by the platform.'
      : 'No tester step in this pipeline: this run verified the change from the repository ' +
        'instead.'
  const enforcement = hasCiGate ? ', and the CI gate is what runs those tests' : ''
  const reported = verdict.contradicted
    ? `reported "${OUTCOME_LABEL[verdict.claimed]}" over a branch it pushed nothing to`
    : `reported "${OUTCOME_LABEL[verdict.effective]}"`
  return (
    `${opening} The integration-test step ${reported} (${counts})${enforcement}. See the step's ` +
    'own report for the detail.'
  )
}
