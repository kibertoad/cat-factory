// Fixtures for the vitest-report grader. Run with `node --test scripts/`, the built-in runner, so
// CI's `repo-guards` job stays install-free like every other guard in it.
//
// The bug this grader catches is the one that looks like a pass: a lane whose suite asserted
// nothing exits 0 and reports green. So the cases that decide whether it works are the three shapes
// of nothing (no assertions, all skipped, a report that is not one), the two shapes of a failure
// the assertions do not carry (a hook that threw around passing specs, a file that never
// collected), the two signals outside the report entirely, and the ordinary ones.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseArgs, problems, summarise } from './grade-vitest-report.mjs'

const report = (...assertionResults) =>
  JSON.stringify({
    numTotalTests: assertionResults.length,
    success: assertionResults.every((result) => result?.status === 'passed'),
    testResults: [
      { name: '/repo/test/os-live/os-leg.spec.ts', status: 'passed', assertionResults },
    ],
  })

/** A whole report, for the cases whose subject is a FILE or the verdict rather than an assertion. */
const fullReport = (success, ...testResults) => JSON.stringify({ success, testResults })

const file = (name, status, assertionResults, message = '') => ({
  name,
  status,
  message,
  assertionResults,
})

const spec = (fullName, status) => ({ fullName, status })

const found = (raw, runnerExit) => problems(summarise(raw), 'the leg', runnerExit)

describe('summarise', () => {
  it('counts only the assertions that actually ran', () => {
    // `numTotalTests` counts the skipped one; the grade must not.
    const summary = summarise(
      report(spec('a', 'passed'), spec('b', 'failed'), spec('c', 'skipped')),
    )
    assert.equal(summary.kind, 'read')
    assert.equal(summary.executed, 2)
    assert.deepEqual(summary.failed, ['b'])
    assert.deepEqual(summary.skipped, ['c'])
  })

  it('treats every spelling of "did not run" as skipped', () => {
    // Reporters have used several over the years, and a status this grader does not recognise must
    // fall on the side that FAILS the lane rather than the side that passes it silently.
    const summary = summarise(report(spec('a', 'pending'), spec('b', 'todo'), spec('c', undefined)))
    assert.equal(summary.executed, 0)
    assert.deepEqual(summary.skipped, ['a', 'b', 'c'])
  })

  it('reports an unparseable report as its own fact', () => {
    // Separate from an absent one: a report that is present and is not JSON is a runner killed
    // mid-write, which is a different thing to look at than a runner that never started.
    const summary = summarise('{ this is not json')
    assert.equal(summary.kind, 'unreadable')
  })
})

describe('problems', () => {
  it('passes a run where every spec executed and none failed', () => {
    assert.deepEqual(found(report(spec('a', 'passed'), spec('b', 'passed'))), [])
  })

  it('fails a run that collected nothing', () => {
    // The shape this grader exists for: vitest exits 0, and so would a step that read the code.
    const problems = found(report())
    assert.equal(problems.length, 1)
    assert.match(problems[0], /no spec executed/)
  })

  it('fails a run whose specs were all skipped, naming each one', () => {
    // The second shape, and the one `--passWithNoTests=false` does not catch: files were collected,
    // tests were counted, and no assertion was made.
    const problems = found(report(spec('the account is minted', 'skipped')))
    assert.equal(problems.length, 2)
    assert.match(problems[0], /no spec executed/)
    assert.match(problems[1], /spec did not run: the account is minted/)
  })

  it('names every failing spec rather than counting them', () => {
    const problems = found(report(spec('a', 'failed'), spec('b', 'failed'), spec('c', 'passed')))
    assert.deepEqual(problems, ['the leg: spec failed: a', 'the leg: spec failed: b'])
  })

  it('names a spec the reporter did not', () => {
    // A report entry with no `fullName` must still produce a line: a silently dropped skip is the
    // failure mode the whole grader is against.
    const problems = found(report({ status: 'skipped' }))
    assert.match(problems.at(-1), /spec did not run: an unnamed spec/)
  })
})

describe('a failure the assertions do not carry', () => {
  it('fails a file whose hook threw around passing specs', () => {
    // The OS leg's shape: its no-unmocked-outbound-call invariant is an `afterAll`, so violating it
    // leaves every assertion `passed` and the FILE failed. Read off the assertions alone this is
    // the green a broken lane reports.
    const problems = found(
      fullReport(
        false,
        file(
          '/repo/os-leg.spec.ts',
          'failed',
          [spec('a', 'passed')],
          'AssertionError: [] deep\n  at x',
        ),
      ),
    )
    assert.equal(problems.length, 1)
    assert.match(problems[0], /os-leg\.spec\.ts failed outside its specs/)
    assert.match(problems[0], /AssertionError/)
    // The stack is dropped, and the drop says so rather than reading as the whole message.
    assert.match(problems[0], /\+1 more line/)
  })

  it('fails a file that collected nothing beside one that passed', () => {
    // A spec file that throws on import contributes no assertion at all, so the sibling's passes
    // are the only thing an assertion-only grade can see.
    const problems = found(
      fullReport(
        false,
        file('/repo/ok.spec.ts', 'passed', [spec('a', 'passed')]),
        file('/repo/broken.spec.ts', 'failed', [], 'Error: Cannot find module'),
      ),
    )
    assert.equal(problems.length, 1)
    assert.match(problems[0], /broken\.spec\.ts failed outside its specs.*Cannot find module/)
  })

  it('states an ordinary failing spec once, not twice', () => {
    // The file is failed BECAUSE the spec is, and naming both would train a reader to skim.
    const problems = found(
      fullReport(false, file('/repo/a.spec.ts', 'failed', [spec('a', 'failed')])),
    )
    assert.deepEqual(problems, ['the leg: spec failed: a'])
  })
})

describe('the signals outside the report', () => {
  it('fails a run the report calls failed while naming nothing', () => {
    // Neither an assertion nor a file carries it. The verdict is still a fact, and the alternative
    // is grading a failed run green because its reporter was terse.
    const problems = found(
      fullReport(false, file('/repo/a.spec.ts', 'passed', [spec('a', 'passed')])),
    )
    assert.equal(problems.length, 1)
    assert.match(problems[0], /records the run as failed and names no failing spec or file/)
  })

  it('fails a clean-looking report the runner exited non-zero on', () => {
    // The last backstop: the report is entirely consistent and the process still died. Discarding
    // this (a `|| true` with nothing catching the code) leaves the grade weaker than the exit code
    // it replaced.
    const problems = found(report(spec('a', 'passed')), 1)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /the runner exited 1/)
  })

  it('passes a clean run the runner exited 0 on', () => {
    assert.deepEqual(found(report(spec('a', 'passed')), 0), [])
  })

  it('explains a failure once, naming the spec rather than the exit code', () => {
    // Both backstops are live here; neither may add a line, or every ordinary red run grows a
    // trailing "and also the runner exited 1" that says nothing.
    const problems = found(
      fullReport(false, file('/repo/a.spec.ts', 'failed', [spec('a', 'failed')])),
      1,
    )
    assert.deepEqual(problems, ['the leg: spec failed: a'])
  })
})

describe('parseArgs', () => {
  it('reads the report path alongside both options, in any order', () => {
    assert.deepEqual(parseArgs(['--label', 'the leg', 'r.json', '--runner-exit', '3']), {
      kind: 'parsed',
      path: 'r.json',
      label: 'the leg',
      runnerExit: 3,
    })
  })

  it('defaults the runner exit to a pass so a caller with nothing to say need not lie', () => {
    assert.deepEqual(parseArgs(['r.json']), {
      kind: 'parsed',
      path: 'r.json',
      label: 'the suite',
      runnerExit: 0,
    })
  })

  it('refuses an exit code it cannot read rather than treating it as zero', () => {
    // `--runner-exit ''` is what a shell that never ran the command produces, and reading it as a
    // pass is the exact failure this argument exists to prevent.
    assert.equal(parseArgs(['r.json', '--runner-exit', '']).kind, 'usage')
    assert.equal(parseArgs(['r.json', '--runner-exit']).kind, 'usage')
  })

  it('refuses an unknown option instead of reading it as the report path', () => {
    assert.equal(parseArgs(['r.json', '--verbose']).kind, 'usage')
  })

  it('refuses no path, and more than one', () => {
    assert.equal(parseArgs([]).kind, 'usage')
    assert.equal(parseArgs(['a.json', 'b.json']).kind, 'usage')
  })

  it("does not read an option's value as the report path", () => {
    // What the previous positional-argument scan did whenever the label was not the value it
    // happened to compare against.
    assert.deepEqual(parseArgs(['--label', 'r.json', 'report.json']), {
      kind: 'parsed',
      path: 'report.json',
      label: 'r.json',
      runnerExit: 0,
    })
  })
})
