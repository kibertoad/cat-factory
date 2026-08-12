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
// before every OTHER scenario (`assertPrerequisites`), because a pass resumed into the feature
// scenario never executes this one and would otherwise skip the checks entirely. What this adds is
// granularity: one named step per prerequisite, so the report reads as a list of named claims rather
// than as one long error string.

import assert from 'node:assert/strict'
import { evaluatePrerequisites, type Harness } from '../harness.ts'
import { advisoryNotes, formatPreflightLine, formatPrerequisiteFailure } from '../preflight.ts'
import { PREREQUISITES } from '../prerequisites.ts'
import type { Scenario } from '../scenarioRunner.ts'

export function preflightScenario(harness: Harness): Scenario {
  const { config, journal } = harness
  return {
    id: '00-preflight',
    title: 'preflight: the deployment, the key, the wiring and the cluster',
    gated: false,
    async run(step) {
      const report = await step(
        `reads every prerequisite against ${config.baseUrl} (workspace ${config.workspaceId})`,
        () => evaluatePrerequisites(harness),
      )

      // One step per prerequisite, named from the registry rather than restated here: a prerequisite
      // added to `PREREQUISITES` gains its own step with no second edit, which is what stops this
      // file from drifting into a stale subset of the gate it reports on.
      //
      // The one-line verdict for EVERY prerequisite is already on screen by now (the evaluation
      // above prints each as it resolves), so the step that fails is where the numbered remedy goes
      // rather than where the news arrives.
      for (const prerequisite of PREREQUISITES) {
        await step(`${prerequisite.id}: ${prerequisite.what}`, async () => {
          const result = report.results.find((entry) => entry.id === prerequisite.id)
          assert.ok(result, `preflight recorded no result for '${prerequisite.id}'`)
          // An advisory is REPORTED and never fails: `pipeline-catalog` is the worked example, where
          // a board that has not adopted a pipeline materialises it on first start.
          if (result.disposition === 'advisory') {
            if (result.verdict.status !== 'satisfied') console.warn(formatPreflightLine(result))
            return
          }
          // The message is the FULL failure (problem, then numbered steps and commands) rather than
          // the one-line summary: this is the report a person reads when exactly one prerequisite is
          // red, and sending them to another file for the fix wastes the report.
          assert.equal(
            result.verdict.status,
            'satisfied',
            `\n${formatPrerequisiteFailure(result)}\n`,
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
