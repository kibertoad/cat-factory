import { describe, expect, it } from 'vitest'
import type { Harness } from '../src/harness.ts'
import { SCENARIOS } from '../src/scenarios/index.ts'

// The REAL scenario list, which `test/scenarioRunner.test.ts` deliberately cannot see: that file
// drives the loop with synthetic scenarios, so it pins how the driver walks an array and says
// nothing about the array the pass is handed. Both halves are needed, and the gap between them is
// where a live bug lived: the vitest sequencer reordered the specs from a results cache and, paired
// with `bail: 1`, ran the last one first, failed it on an empty ledger in two milliseconds and
// stopped the pass before the one that populates that ledger had started. `src/specOrder.ts` was
// the fix, and it had a test; the array that replaced it had none, so reordering these five (or
// pasting `gated: false` from the preflight into a scenario that spends) went back to failing
// nothing at all.
//
// Every assertion here is a RELATION over the list rather than a copy of it, because the list is
// meant to grow. A hard-coded id array would fail on the ordinary act of adding a scenario, name
// nothing about what broke, and train the next person to re-pin it unread; a relation fails only
// when a scenario is in the wrong PLACE, which is the whole bug.

/**
 * Enough harness for a factory to be BUILT, which is all this file needs.
 *
 * A scenario factory closes over the harness and returns its description; the work is inside `run`,
 * which nothing here calls. What the five touch at build time is `config.namePrefix` (the frame
 * titles) and the ledger, so those are real and the rest is unreachable from here.
 */
function buildable(): Harness {
  return {
    config: { namePrefix: 'acc', workspaceId: 'ws_test', baseUrl: 'https://example.test' },
    world: { value: { runId: 'test' } },
  } as unknown as Harness
}

const scenarios = SCENARIOS.map((build) => build(buildable()))

describe('SCENARIOS', () => {
  it('is in narrative order, which each id states in its own prefix', () => {
    // The ids carry `00-`…`04-` as a label for the reader, and the label is only true if the array
    // agrees with it. Derived from the position rather than listed, so a sixth scenario passes when
    // it is added in the right place and fails when it is not.
    expect(scenarios.map((scenario) => scenario.id)).toEqual(
      scenarios.map(
        (scenario, index) => `${String(index).padStart(2, '0')}-${scenario.id.slice(3)}`,
      ),
    )
  })

  it('names each scenario once', () => {
    // Two scenarios under one id file an afternoon of observations under one journal phase and
    // report as one line of the summary.
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length)
  })

  it('leaves exactly one scenario ungated, and it is the first', () => {
    // Rule 0. The preflight REPORT is ungated because it IS the gate, rendered one named claim at a
    // time, and would otherwise be refused before it could say which prerequisite is red. Any OTHER
    // ungated scenario spends an afternoon against a deployment nothing checked, which is the
    // failure the required `gated` flag exists to make somebody answer for. Copy-pasting a
    // neighbouring factory is how that answer becomes wrong.
    expect(scenarios.filter((scenario) => !scenario.gated).map((scenario) => scenario.id)).toEqual([
      scenarios[0]?.id,
    ])
  })

  it('gives every scenario a title, which is what an operator reads it as', () => {
    expect(scenarios.every((scenario) => scenario.title.trim().length > 0)).toBe(true)
  })
})
