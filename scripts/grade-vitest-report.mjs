#!/usr/bin/env node
// Grade a vitest JSON report as a CI step: did the suite actually assert anything, and did all of
// it pass?
//
// A workflow step that reads a suite's exit code grades two of the three things that can go wrong.
// A run that collected NOTHING and a run whose specs were every one of them SKIPPED both exit 0,
// and the second survives `--passWithNoTests=false` as well, because vitest counts a skipped spec
// as a test. This repo's rule is that a phase which reported nothing is not a pass, so a lane whose
// value is "a red run means something" has to look at the per-assertion statuses.
//
// `@cat-factory/sdk-smoketest`'s gatekeeper phase makes the same judgement about the OTHER live
// leg, in-process and in a different shape: it folds each failed and skipped spec into the failure
// strings of a parity report it is one section of. What it cannot do is be this, because it is a
// built TypeScript package that cannot reach a repository script; what this cannot do is be that,
// because a workflow step's product is an exit code. They are kept in step by the fixtures beside
// each.
//
//   node scripts/grade-vitest-report.mjs <report.json> [--label "the Gatekeeper OS leg"]
//
// Exits 0 when at least one spec executed and none failed or was skipped, and 1 otherwise, naming
// every spec that failed or did not run.

import { readFileSync } from 'node:fs'

/**
 * Reduce a vitest JSON report to the three facts a lane is graded on.
 *
 * Counted off the individual ASSERTIONS rather than the report's own totals, which count a skipped
 * spec as a test: read that way, an all-skipped suite satisfies every check here while having
 * asserted nothing.
 *
 * @param {string} raw
 * @returns {{ kind: 'read', executed: number, failed: string[], skipped: string[] }
 *   | { kind: 'unreadable', detail: string }}
 */
export function summarise(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) }
  }

  const files = Array.isArray(parsed?.testResults) ? parsed.testResults : []
  const assertions = files.flatMap((file) =>
    Array.isArray(file?.assertionResults) ? file.assertionResults : [],
  )
  const nameOf = (assertion) => assertion?.fullName ?? 'an unnamed spec'
  const ran = (assertion) => assertion?.status === 'passed' || assertion?.status === 'failed'

  return {
    kind: 'read',
    executed: assertions.filter(ran).length,
    failed: assertions.filter((a) => a?.status === 'failed').map(nameOf),
    // Anything that is neither passed nor failed did not execute, whichever of vitest's several
    // spellings for that the reporter used.
    skipped: assertions.filter((a) => !ran(a)).map(nameOf),
  }
}

/**
 * What is wrong with this run, as the lines a reader acts on. Empty means it passed.
 *
 * @param {ReturnType<typeof summarise>} summary
 * @param {string} label
 * @returns {string[]}
 */
export function problems(summary, label) {
  if (summary.kind === 'unreadable') {
    return [`${label}: its report is not readable JSON (${summary.detail}).`]
  }

  const found = []
  if (summary.executed === 0) {
    found.push(`${label}: no spec executed, so nothing this lane claims to assert was asserted.`)
  }
  // NAMED, not just counted: a skipped spec is an assertion the lane claims to make and did not,
  // and a count alone leaves a reader to work out which one from a suite they cannot see.
  for (const name of summary.failed) found.push(`${label}: spec failed: ${name}`)
  for (const name of summary.skipped) found.push(`${label}: spec did not run: ${name}`)
  return found
}

function main(argv) {
  const args = argv.slice(2)
  const labelAt = args.indexOf('--label')
  const label = labelAt === -1 ? 'the suite' : (args[labelAt + 1] ?? 'the suite')
  const path = args.find((arg) => !arg.startsWith('--') && arg !== label)
  if (path === undefined) {
    console.error('usage: node scripts/grade-vitest-report.mjs <report.json> [--label <name>]')
    return 1
  }

  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    // A DIFFERENT fact from an unparseable report, and both are named: nothing was written at all
    // (the runner never got as far as a spec) versus something was written and is not a report.
    console.error(
      `${label}: no report was written to ${path} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'The runner did not get as far as running a spec; its own output says why.',
    )
    return 1
  }

  const summary = summarise(raw)
  const found = problems(summary, label)
  for (const problem of found) console.error(problem)
  if (found.length === 0 && summary.kind === 'read') {
    console.log(`${label}: ${summary.executed} spec(s) executed, all passed.`)
  }
  return found.length === 0 ? 0 : 1
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv)
}
