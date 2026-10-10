// The Gatekeeper phase's GRADING, which is the half of that phase whose bug is silent.
//
// The specs it runs assert against a real deployment and fail loudly when they are wrong. What
// cannot fail loudly is the reduction here: read the report one way and a suite that executed
// nothing at all satisfies every expectation and prints the success line. So the two ways that
// happens (a report full of skips, a report that is not a report) each get a test, and so does the
// green case they have to be told apart from.

import { describe, expect, it } from 'vitest'
import {
  compareGatekeeperReport,
  gradeSuiteRun,
  type ReportRead,
  summariseVitestReport,
} from '../src/gatekeeper.ts'

/** A vitest JSON report carrying one assertion per given status. */
function reportWith(...statuses: string[]): string {
  return JSON.stringify({
    // Present and WRONG on purpose: the totals count a skipped spec as a test, which is why the
    // reduction may not read them. A grader that regressed to `numTotalTests` passes every other
    // test in this file and fails these.
    numTotalTests: statuses.length,
    numFailedTests: statuses.filter((status) => status === 'failed').length,
    testResults: [
      {
        assertionResults: statuses.map((status, index) => ({
          status,
          fullName: `live > spec ${index}`,
        })),
      },
    ],
  })
}

/** Grade a run that exited 0 with the given report, the way the phase does. */
function grade(report: ReportRead) {
  return compareGatekeeperReport(
    gradeSuiteRun({ exitCode: 0, output: 'child output' }, report, '/tmp/r.json'),
  )
}

describe('summariseVitestReport', () => {
  it('counts only the specs that actually executed', () => {
    const summary = summariseVitestReport(reportWith('passed', 'passed', 'skipped', 'failed'))

    expect(summary).toMatchObject({ kind: 'read', executed: 3, failed: 1, skipped: 1 })
  })

  it('treats every non-executing status as a skip, whichever spelling the reporter used', () => {
    // vitest has spelled a non-running test `pending`, `skipped` and `todo` across versions and
    // reporters. Enumerating the ones that DID run is what makes that irrelevant here.
    const summary = summariseVitestReport(reportWith('pending', 'skipped', 'todo'))

    expect(summary).toMatchObject({ kind: 'read', executed: 0, skipped: 3 })
  })

  it('names the specs that failed and the specs that did not run', () => {
    const summary = summariseVitestReport(reportWith('failed', 'skipped'))

    expect(summary).toMatchObject({
      failedNames: ['live > spec 0'],
      skippedNames: ['live > spec 1'],
    })
  })

  it('reports a truncated report as unreadable rather than throwing', () => {
    // A child killed mid-write leaves exactly this, and it is the moment the phase's own report
    // matters most: a throw here escapes `run.ts` and takes the child's output with it.
    const summary = summariseVitestReport(reportWith('passed').slice(0, 40))

    expect(summary.kind).toBe('unreadable')
  })
})

describe('gradeSuiteRun', () => {
  it('passes a run whose specs all executed and all passed', () => {
    expect(grade(summariseVitestReport(reportWith('passed', 'passed')))).toEqual([])
  })

  it('REFUSES a suite that only skipped, though it exited 0 and failed nothing', () => {
    const problems = grade(summariseVitestReport(reportWith('skipped', 'skipped')))

    // Both halves: nothing executed, and the skips are named rather than merely counted.
    expect(problems.map((problem) => problem.detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('spec did not run: live > spec 0'),
        expect.stringContaining("'suiteExecutedSpecs' is false"),
        expect.stringContaining("'suiteSkippedSpecs' is 2"),
      ]),
    )
  })

  it('REFUSES a suite that skipped one spec among passing ones', () => {
    // The partial case is the one a count-only grader lets through: something executed, nothing
    // failed, and an assertion this lane claims to make was still not made.
    const problems = grade(summariseVitestReport(reportWith('passed', 'skipped')))

    expect(problems.map((problem) => problem.detail)).toContainEqual(
      expect.stringContaining('spec did not run: live > spec 1'),
    )
  })

  it('quotes the child output on an absent report, and tells it apart from an unreadable one', () => {
    const absent = grade({ kind: 'absent' })
    const unreadable = grade({ kind: 'unreadable', detail: 'Unexpected end of JSON input' })

    expect(absent[0]?.detail).toContain('produced no report')
    expect(absent[0]?.detail).toContain('child output')
    expect(unreadable[0]?.detail).toContain('not readable JSON')
    expect(unreadable[0]?.detail).toContain('child output')
  })

  it('reports a non-zero exit with no failing spec, which no spec name would explain', () => {
    const report = gradeSuiteRun(
      { exitCode: 1, output: 'pool crashed' },
      summariseVitestReport(reportWith('passed')),
      '/tmp/r.json',
    )

    expect(report.failures).toContainEqual(expect.stringContaining('exited 1 with no failing spec'))
  })
})
