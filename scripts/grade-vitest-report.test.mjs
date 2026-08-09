// Fixtures for the vitest-report grader. Run with `node --test scripts/`, the built-in runner, so
// CI's `repo-guards` job stays install-free like every other guard in it.
//
// The bug this grader catches is the one that looks like a pass: a lane whose suite asserted
// nothing exits 0 and reports green. So the cases that decide whether it works are the three shapes
// of nothing (no assertions, all skipped, a report that is not one) plus the two ordinary ones.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { problems, summarise } from './grade-vitest-report.mjs'

const report = (...assertionResults) =>
  JSON.stringify({
    numTotalTests: assertionResults.length,
    testResults: [{ assertionResults }],
  })

const spec = (fullName, status) => ({ fullName, status })

const found = (raw) => problems(summarise(raw), 'the leg')

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
