// The ORDER the five scenarios run in, which is the suite's premise rather than a preference.
//
// The scenarios are ONE narrative: 01 adopts the two services 02 ships a feature across, 03
// investigates the defect that feature left, and 04 delivers an issue against the same board. Each
// one reads what the previous recorded, through the on-disk ledger, so a scenario that runs before
// its predecessor cannot do anything but fail on a ledger key nobody has written yet.
//
// **This array IS the order**, walked by `runScenarios`, and that is the whole of the mechanism. It
// replaced a vitest sequencer (`src/specOrder.ts`, deleted with this runner) which existed because
// vitest's default `BaseSequencer.sort()` reorders the files it is handed from a cache of the
// PREVIOUS run: previously-failed first, then longest-duration first. Every rule there is right for
// an ordinary suite and exactly wrong here, and paired with `bail: 1` it ran whichever scenario was
// slowest last time FIRST, failed it on an empty ledger in two milliseconds, and stopped the pass
// before the one that populates that ledger had started. The numeric prefixes in the ids are now
// only what they always claimed to be: a label for the reader, matching this list.

import { type Scenario } from '@cat-factory/acceptance-kit'
import type { Harness } from '../harness.ts'
import { adoptAndScaffoldScenario } from './adoptAndScaffold.ts'
import { featureWithDefectScenario } from './featureWithDefect.ts'
import { investigateAndFixScenario } from './investigateAndFix.ts'
import { issueIntakeToCloseScenario } from './issueIntakeToClose.ts'
import { preflightScenario } from './preflight.ts'

/**
 * A scenario, bound to the pass's harness.
 *
 * Built rather than declared, because a scenario closes over the client, the ledger and the journal
 * of THIS pass and the harness does not exist until the run id and the password are settled. It is
 * also what keeps the driver ignorant of the harness: the kit's `scenarioRunner.ts` sees a list of `Scenario`
 * and a gate seam, which is why it is unit-testable with no deployment.
 */
export type ScenarioFactory = (harness: Harness) => Scenario

export const SCENARIOS: readonly ScenarioFactory[] = [
  preflightScenario,
  adoptAndScaffoldScenario,
  featureWithDefectScenario,
  investigateAndFixScenario,
  issueIntakeToCloseScenario,
]
