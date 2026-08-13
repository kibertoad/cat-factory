// Scenario 00: everything that must be true before the suite is allowed to spend anything.
//
// The whole point of this scenario is that it is CHEAP and comes FIRST. Every check here has a
// counterpart failure much later in the run, wearing a much worse face: a key bound to another
// workspace looks like a deployment that lost its board, an unwired model looks like a broken
// dispatcher, a connection without workflow permission looks like a repository whose CI never
// fires, and a preset that holds every merge for a person looks like a run that stalled on its
// last step. Spending a handful of HTTP calls to say which of those it really is buys back an
// afternoon.
//
// It asserts NOTHING about the product. It is a setup check, and it says so in every message.
//
// **This scenario is a REPORT, not the gate**, which is why it is the one scenario that declares
// itself ungated. The prerequisites are defined in `src/prerequisites.ts` and the driver runs them
// before every OTHER scenario (`harness.prerequisites.assert`), because a pass resumed into the
// feature scenario never executes this one and would otherwise skip the checks entirely. What this
// adds is granularity: one named step per prerequisite, so the report reads as a list of named
// claims rather than as one long error string.
//
// Both go through the pass's ONE gate object, which is also what stops this scenario and the gate
// seconds behind it from evaluating the same fourteen prerequisites twice: the report this scenario
// pays for is offered to the next `assert` and consumed by it (`createPrerequisiteGate`).

import assert from 'node:assert/strict'
import type { Harness } from '../harness.ts'
import { scrubbed } from '../operatorText.ts'
import {
  advisoryNotes,
  formatPreflightFailure,
  formatPreflightLine,
  formatPrerequisiteFailure,
} from '../preflight.ts'
import { PREREQUISITES } from '../prerequisites.ts'
import type { Scenario } from '../scenarioRunner.ts'

export function preflightScenario(harness: Harness): Scenario {
  const { config, journal, prerequisites } = harness
  return {
    id: '00-preflight',
    title: 'preflight: the deployment, the key, the wiring and the cluster',
    gated: false,
    async run(step) {
      // SCRUBBED, because a step name is not console-only: the driver writes the failing one into
      // the journal (`journalFailure`), which is the file the README presents as safe to read and
      // to paste into an issue. A base URL may legitimately carry userinfo
      // (`https://svc:secret@backend.example.com`) and no URL policy rejects it, so the credential
      // would be persisted by the one step whose whole job is to run before anything is spent.
      const report = await step(
        `reads every prerequisite against ${scrubbed(config.baseUrl)} (workspace ${config.workspaceId})`,
        // Through the pass's gate rather than a bare evaluation, so the report this scenario just
        // paid for is the one the NEXT scenario's gate reads. See `createPrerequisiteGate`.
        () => prerequisites.evaluate(),
      )

      // The refusal the GATE would raise, computed once from the report this scenario just paid for:
      // every blocking prerequisite with its own remedy, which is rule 4 ("report every failing claim,
      // not just the first"). Null when nothing blocks.
      //
      // It is what a failing step below carries, rather than that step's own prerequisite alone. A
      // step throws and the driver bails, so the one-remedy form delivered a single fix and then ended
      // the pass: an operator with three red prerequisites paid a round trip per item, while the
      // terser gate seconds behind this scenario would have printed all three. The scenario written to
      // ADD granularity may not report less than the refusal it reports on.
      const refusal = formatPreflightFailure(report)

      // One step per prerequisite, named from the registry rather than restated here: a prerequisite
      // added to `PREREQUISITES` gains its own step with no second edit, which is what stops this
      // file from drifting into a stale subset of the gate it reports on.
      //
      // The one-line verdict for EVERY prerequisite is already on screen by now (the evaluation
      // above prints each as it resolves, through the pass's own log seam), so the step that fails is
      // where the numbered remedies go rather than where the news arrives. Which is also why an
      // unsatisfied ADVISORY needs nothing here: its verdict line is already printed, the closing step
      // records it in the journal, and a second copy from this loop went to a different stream than
      // every other line of the pass.
      for (const prerequisite of PREREQUISITES) {
        await step(`${prerequisite.id}: ${prerequisite.what}`, async () => {
          const result = report.results.find((entry) => entry.id === prerequisite.id)
          assert.ok(result, `preflight recorded no result for '${prerequisite.id}'`)
          // An advisory is REPORTED and never fails: `pipeline-catalog` is the worked example, where
          // a board that has not adopted a pipeline materialises it on first start.
          if (result.disposition === 'advisory') return
          // The FULL failures (problem, then numbered steps and commands) rather than one-line
          // summaries: this is the report a person reads when a prerequisite is red, and sending them
          // to another file for the fix wastes the report. `refusal` covers exactly the required
          // prerequisites that are not satisfied, which this one is whenever this assertion fires; its
          // own rendering is the answer for the case where the report somehow blocks on nothing.
          assert.equal(
            result.verdict.status,
            'satisfied',
            `\n${refusal ?? formatPrerequisiteFailure(result)}\n`,
          )
        })
      }

      await step('leaves the pass with nothing to create and its notes stated', async () => {
        for (const note of advisoryNotes(report)) {
          journal.record('prerequisite', `advisory: ${formatPreflightLine(note).trim()}`)
        }
        journal.finishPhase(`preflight passed ${report.results.length} prerequisite(s)`)
        assert.equal(report.results.length, PREREQUISITES.length)
      })
    },
  }
}
