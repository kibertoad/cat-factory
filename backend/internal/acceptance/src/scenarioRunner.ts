// The driver: five scenarios, in order, in ONE process, stopping at the first failure.
//
// This is what replaced vitest for the acceptance scenarios, and it is deliberately small. What the
// suite needed from a test framework was `describe`/`it` structure, 18 assertions and a mechanism
// (`provide`/`inject`) that existed only to undo vitest's own file isolation; everything else it had
// already built for itself (the ledger, the journal, per-wait deadlines, the refusal gate, resume).
// Design record: `backend/docs/adr/0057-acceptance-standalone-runner.md`.
//
// Four properties are the whole contract, and each is a property somebody debugged into existence:
//
//   - **Order is the array**, not a cache or a sequencer. `src/scenarios/index.ts` lists the five in
//     narrative order and this loop walks it. The sequencer this replaced existed because vitest
//     reordered from a results cache (previously-failed first, then longest first), which paired
//     with `bail: 1` ran the last of the five first and stopped the pass before the one that
//     populates the ledger had started.
//   - **BAIL is the behaviour, not an option.** The narrative is sequential, so the second failure is
//     the first one's shadow, and every scenario after a failure would spend real model money on
//     work whose input never got created. What follows a failure is reported as `not run`, never as
//     passed and never as skipped-by-choice.
//   - **The prerequisite gate is run BY THIS LOOP** for every scenario that declares itself gated
//     (rule 0), rather than by each scenario's own first line. A scenario added without it would
//     otherwise spend an afternoon against an unwired deployment, and `gated` being required means a
//     new one cannot be written without answering the question.
//   - **No timeout, in any form.** `src/deadline.ts` owns every wait and reports what it last saw; a
//     per-scenario deadline here would replace "step `coder` was still working, 4/9 subtasks" with an
//     anonymous expiry, which is the exact regression the disabled vitest timeout existed to prevent.

import { formatDuration } from './deadline.ts'
import { failureWithLocation } from './operatorText.ts'

/**
 * Run one named piece of work, printed as it starts and timed as it ends.
 *
 * Generic in the return value so a scenario can name a step and still use what it produced, which is
 * what the `const record = await step(...)` shape in the scenarios needs. A step that throws ends
 * the scenario and the pass: there is no soft failure, because a claim this suite cannot make is not
 * one to carry on past.
 */
export type ScenarioStep = <T>(name: string, work: () => Promise<T>) => Promise<T>

/** One scenario: what it is, whether the gate guards it, and the steps it runs. */
export type Scenario = {
  /** The journal phase and the name in every report, e.g. `02-feature-with-defect`. */
  id: string
  /** One line saying what the scenario claims. */
  title: string
  /**
   * Whether the prerequisite gate runs before this scenario's first step (rule 0).
   *
   * REQUIRED rather than defaulted, so a new scenario cannot be added without deciding. Exactly one
   * scenario answers `false`: the preflight REPORT, which is the gate rendered one named claim at a
   * time and would otherwise be refused by the gate before it could say which prerequisite is red.
   */
  gated: boolean
  run: (step: ScenarioStep) => Promise<void>
}

/** What failed, and the text an operator reads. */
export type ScenarioFailure = {
  /** The step that threw, or null when the scenario threw outside one. */
  step: string | null
  text: string
}

export type ScenarioOutcome = {
  id: string
  /** `not-run` is a consequence of an earlier failure, never a choice. */
  status: 'passed' | 'failed' | 'not-run'
  /** Steps that FINISHED, so a failing scenario says how far it got. */
  steps: number
  elapsedMs: number
  failure: ScenarioFailure | null
}

export type ScenarioRunnerDeps = {
  /** A scenario is opening: bind the journal phase and announce it. */
  open: (scenario: Scenario) => void
  /**
   * The prerequisite gate, run as this loop's own first step for every gated scenario.
   *
   * It takes NO scenario, because there is exactly one gate and it cannot vary by scenario: what
   * varies is only whether it runs, which is the scenario's own `gated` flag and this loop's
   * decision. A parameter here would advertise a per-scenario gate that nothing can implement.
   */
  gate: () => Promise<void>
  /** Operator output. */
  log: (message: string) => void
  /**
   * A scenario failed: the durable half of the report (`journal.ts`'s `failure` kind).
   *
   * Also without the scenario, and for a related reason: the journal is already in that scenario's
   * PHASE (the `open` seam entered it), so a handler that took the scenario would be re-deciding
   * what the line is filed under, which is exactly how two answers come to disagree.
   */
  onFailure: (failure: ScenarioFailure) => void
  now: () => number
}

/**
 * Every scenario in the order given, stopping at the first failure.
 *
 * Answers an outcome per scenario rather than throwing, so the caller owns the summary and the exit
 * code (`scenariosExitCode`) and this function can be driven from a unit test with no deployment.
 */
export async function runScenarios(
  deps: ScenarioRunnerDeps,
  scenarios: readonly Scenario[],
): Promise<readonly ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = []
  let stopped = false
  for (const scenario of scenarios) {
    if (stopped) {
      outcomes.push({ id: scenario.id, status: 'not-run', steps: 0, elapsedMs: 0, failure: null })
      continue
    }
    const outcome = await runScenario(deps, scenario)
    outcomes.push(outcome)
    stopped = outcome.status === 'failed'
  }
  return outcomes
}

/**
 * One scenario: the gate, then its steps, then the outcome.
 *
 * The gate is run through the same `step` the scenario's own work goes through rather than beside it,
 * so a refused prerequisite is attributed and timed exactly like anything else and the failure names
 * it. Everything a scenario throws is caught HERE and nowhere deeper: a scenario is one narrative
 * step of an afternoon-long pass, and swallowing anything inside it would report a claim as made.
 */
async function runScenario(deps: ScenarioRunnerDeps, scenario: Scenario): Promise<ScenarioOutcome> {
  const startedAt = deps.now()
  let finished = 0
  let current: string | null = null
  const step: ScenarioStep = async (name, work) => {
    current = name
    const stepStartedAt = deps.now()
    deps.log(`  - ${name}`)
    const value = await work()
    finished += 1
    current = null
    deps.log(`    ok    (${formatDuration(deps.now() - stepStartedAt)})`)
    return value
  }
  try {
    // Inside the try, like everything else: `open` binds the journal phase, and a scenario whose
    // opening failed is a failed scenario with a summary, not an unhandled rejection that ends the
    // pass with no report.
    deps.open(scenario)
    if (scenario.gated) await step(GATE_STEP, () => deps.gate())
    await scenario.run(step)
    return {
      id: scenario.id,
      status: 'passed',
      steps: finished,
      elapsedMs: deps.now() - startedAt,
      failure: null,
    }
  } catch (error) {
    const failure = { step: current, text: failureWithLocation(error) }
    deps.log(`    FAIL  (${formatDuration(deps.now() - startedAt)})\n\n${failure.text}\n`)
    deps.onFailure(failure)
    return {
      id: scenario.id,
      status: 'failed',
      steps: finished,
      elapsedMs: deps.now() - startedAt,
      failure,
    }
  }
}

/** What the gate is called wherever it is reported. Named once so the two readers agree. */
export const GATE_STEP = 'prerequisites (checked before every scenario, resumed passes included)'

/**
 * The pass in five lines, printed after the failure text rather than instead of it.
 *
 * What it adds over the running commentary is the shape of the whole pass, which is the thing an
 * operator scrolls to after an afternoon: which scenario broke, how far into it, and that the ones
 * after it did not run rather than passed. The failure text itself is deliberately NOT repeated
 * here; it is printed at the failure, immediately above this, and a preflight refusal reprinted in
 * full would push the summary off the screen it exists to be read on.
 */
export function formatScenarioSummary(outcomes: readonly ScenarioOutcome[]): string {
  const width = Math.max(0, ...outcomes.map((outcome) => outcome.id.length))
  const total = outcomes.reduce((sum, outcome) => sum + outcome.elapsedMs, 0)
  const lines = outcomes.map((outcome) => {
    const id = outcome.id.padEnd(width)
    if (outcome.status === 'not-run') return `  not run  ${id}`.trimEnd()
    const label = outcome.status === 'passed' ? 'ok      ' : 'FAIL    '
    const at = outcome.failure?.step ? `  at '${outcome.failure.step}'` : ''
    return (
      `  ${label} ${id}  ${String(outcome.steps).padStart(2)} step(s)  ` +
      `${formatDuration(outcome.elapsedMs)}${at}`
    )
  })
  return `\nsummary  (${formatDuration(total)})\n${lines.join('\n')}`
}

/**
 * 0 only when every scenario passed.
 *
 * A pass that stopped early is a failure whatever the scenario after the break would have said, so
 * `not-run` is not a pass. Stated as "every one passed" rather than "none failed" for that reason:
 * the two differ exactly on the outcomes a bail produces, which is the common case here.
 */
export function scenariosExitCode(outcomes: readonly ScenarioOutcome[]): number {
  return outcomes.every((outcome) => outcome.status === 'passed') ? 0 : 1
}
