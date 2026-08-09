// Spec 00: everything that must be true before the suite is allowed to spend anything.
//
// The whole point of this file is that it is CHEAP and comes FIRST. Every check here has a
// counterpart failure much later in the run, wearing a much worse face: a key bound to another
// workspace looks like a deployment that lost its board, an unwired model looks like a broken
// dispatcher, a connection without workflow permission looks like a repository whose CI never
// fires, and a preset that holds every merge for a person looks like a run that stalled on its
// last step. Spending a handful of HTTP calls to say which of those it really is buys back an
// afternoon.
//
// It asserts NOTHING about the product. It is a setup check, and it says so in every message.
//
// **This spec is a REPORT, not the gate.** The prerequisites are defined in `src/prerequisites.ts`
// and every spec runs them in its own `beforeAll` (`assertPrerequisites`), because a pass resumed
// into spec 02 never executes this file and would otherwise skip the checks entirely. What this
// file adds is granularity: one vitest test per prerequisite, so the report reads as a list of
// named claims rather than as one long error string.

import { beforeAll, describe, expect, it } from 'vitest'
import {
  advisoryNotes,
  formatPreflightLine,
  formatPrerequisiteFailure,
  type PreflightReport,
} from '../src/preflight.ts'
import { PREREQUISITES } from '../src/prerequisites.ts'
import { harness, preflightReport } from './fixtures.ts'

describe('preflight: the deployment, the key, the wiring and the cluster', () => {
  const { config, journal } = harness('00-preflight')
  let report: PreflightReport

  beforeAll(async () => {
    console.log(`preflight against ${config.baseUrl} (workspace ${config.workspaceId})`)
    report = await preflightReport()
  })

  // One test per prerequisite, named from the registry rather than restated here: a prerequisite
  // added to `PREREQUISITES` gains its own test with no second edit, which is what stops this
  // file from drifting into a stale subset of the gate it reports on.
  it.each(PREREQUISITES.map((prerequisite) => [prerequisite.id, prerequisite.what]))(
    '%s: %s',
    (id) => {
      const result = report.results.find((entry) => entry.id === id)
      expect(result, `preflight recorded no result for '${id}'`).toBeDefined()
      if (!result) return
      // An advisory is REPORTED and never fails: `pipeline-catalog` is the worked example, where
      // a board that has not adopted a pipeline materialises it on first start.
      if (result.disposition === 'advisory') {
        if (result.verdict.status !== 'satisfied') console.warn(formatPreflightLine(result))
        return
      }
      // The assertion message is the FULL failure (problem, then numbered steps and commands)
      // rather than the one-line summary: this is the report a person reads when exactly one
      // prerequisite is red, and sending them to another file for the fix wastes the report.
      expect(result.verdict.status, `\n${formatPrerequisiteFailure(result)}\n`).toBe('satisfied')
    },
  )

  it('leaves the pass with nothing to create and its notes stated', () => {
    for (const note of advisoryNotes(report)) {
      journal.record('prerequisite', `advisory: ${formatPreflightLine(note).trim()}`)
    }
    journal.finishPhase(`preflight passed ${report.results.length} prerequisite(s)`)
    expect(report.results.length).toBe(PREREQUISITES.length)
  })
})
