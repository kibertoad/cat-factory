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
// The assertions are not the whole report, and reading only them is the same mistake in the other
// direction: a file can FAIL with every assertion in it passing. A throwing `afterAll` is one (this
// leg's no-unmocked-outbound-call invariant lives in exactly that hook), and a module that throws
// on import is another, contributing no assertion to read at all. So a file's own status, the
// report's own verdict, and the runner's exit code are each graded beside the assertions, and each
// of the four can be the only one that knows. What none of them may do is be silently absent: a
// grade is a total function over the run, or it is the green a broken lane reports.
//
// `@cat-factory/sdk-smoketest`'s gatekeeper phase makes the same judgement about the OTHER live
// leg, in-process and in a different shape: it folds each failed and skipped spec into the failure
// strings of a parity report it is one section of. What it cannot do is be this, because it is a
// built TypeScript package that cannot reach a repository script; what this cannot do is be that,
// because a workflow step's product is an exit code. They are kept in step by the fixtures beside
// each.
//
//   node scripts/grade-vitest-report.mjs <report.json> \
//     [--label "the Gatekeeper OS leg"] [--runner-exit "$exit_code"]
//
// Exits 0 when at least one spec executed, none failed or was skipped, no file failed around its
// specs, and neither the report nor the runner reported a failure. Exits 1 otherwise, naming what
// it found.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * The head of a reporter message, which routinely carries a whole stack.
 *
 * The tail is dropped rather than printed, because the run's own output is above this in the log
 * and carries it in full. A drop is STATED: a reader who took this for the whole message would
 * conclude the rest had been considered and had nothing in it.
 *
 * @param {unknown} message
 * @returns {string}
 */
function firstLine(message) {
  if (typeof message !== 'string') return ''
  const [head, ...rest] = message.trim().split('\n')
  if (head === undefined || head.length === 0) return ''
  return rest.length === 0
    ? head
    : `${head} (+${rest.length} more line(s), in the run's own output)`
}

/**
 * Reduce a vitest JSON report to the facts a lane is graded on.
 *
 * Assertions are counted individually rather than off the report's own totals, which count a
 * skipped spec as a test: read that way, an all-skipped suite satisfies every check here while
 * having asserted nothing. Files and the report's verdict are read BESIDE them, because a file can
 * fail with none of its assertions failing.
 *
 * @param {string} raw
 * @returns {{ kind: 'read', executed: number, failed: string[], skipped: string[],
 *     fileFailures: { file: string, detail: string }[], reportedFailure: boolean }
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
  const assertionsIn = (file) =>
    Array.isArray(file?.assertionResults) ? file.assertionResults : []
  const assertions = files.flatMap(assertionsIn)
  const nameOf = (assertion) => assertion?.fullName ?? 'an unnamed spec'
  const ran = (assertion) => assertion?.status === 'passed' || assertion?.status === 'failed'

  return {
    kind: 'read',
    executed: assertions.filter(ran).length,
    failed: assertions.filter((a) => a?.status === 'failed').map(nameOf),
    // Anything that is neither passed nor failed did not execute, whichever of vitest's several
    // spellings for that the reporter used.
    skipped: assertions.filter((a) => !ran(a)).map(nameOf),
    // A file that failed while naming no failed assertion: a hook outside the specs threw, or the
    // module never collected. Files whose own assertions already name the failure are left out, so
    // an ordinary red spec is stated once rather than twice.
    fileFailures: files
      .filter(
        (file) =>
          file?.status === 'failed' && !assertionsIn(file).some((a) => a?.status === 'failed'),
      )
      .map((file) => ({ file: file?.name ?? 'an unnamed file', detail: firstLine(file?.message) })),
    // The report's own verdict, the backstop for a failure recorded in NEITHER place.
    reportedFailure: parsed?.success === false,
  }
}

/**
 * What is wrong with this run, as the lines a reader acts on. Empty means it passed.
 *
 * `runnerExit` is the suite's own exit code, which the caller has to hand over rather than discard:
 * it is the one signal that survives a report the runner never finished writing, and a step that
 * threw it away would leave this grade weaker than the exit code it replaced.
 *
 * @param {ReturnType<typeof summarise>} summary
 * @param {string} label
 * @param {number} [runnerExit]
 * @returns {string[]}
 */
export function problems(summary, label, runnerExit = 0) {
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
  for (const { file, detail } of summary.fileFailures) {
    const where = `${label}: ${file} failed outside its specs (a hook, or its collection)`
    found.push(detail.length === 0 ? `${where}; the report says no more.` : `${where}: ${detail}`)
  }

  // The two backstops, and the reason they are last: each fires only where nothing above named the
  // cause, so a run that IS explained is explained once. A run that reached neither is still red,
  // pointed at the output that knows why.
  if (found.length === 0 && summary.reportedFailure) {
    found.push(
      `${label}: the report records the run as failed and names no failing spec or file. ` +
        "Its cause is in the run's own output above.",
    )
  }
  if (found.length === 0 && runnerExit !== 0) {
    found.push(
      `${label}: the runner exited ${runnerExit} and its report names nothing that failed. ` +
        "Its cause is in the run's own output above.",
    )
  }
  return found
}

const USAGE =
  'usage: node scripts/grade-vitest-report.mjs <report.json> ' +
  '[--label <name>] [--runner-exit <code>]'

/**
 * Read the command line, refusing anything it does not understand.
 *
 * Every rejection here fails the lane, `--runner-exit ''` (a shell that never ran the command)
 * included. A grader that guessed at its own arguments would be one more way for a broken run to
 * report the pass this whole script exists to withhold.
 *
 * @param {string[]} args
 * @returns {{ kind: 'parsed', path: string, label: string, runnerExit: number }
 *   | { kind: 'usage', detail: string }}
 */
export function parseArgs(args) {
  let label = 'the suite'
  let runnerExit = 0
  const paths = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--label' || arg === '--runner-exit') {
      const value = args[index + 1]
      index += 1
      if (value === undefined) return { kind: 'usage', detail: `${arg} needs a value` }
      if (arg === '--label') {
        label = value
        continue
      }
      const code = Number.parseInt(value, 10)
      if (!Number.isFinite(code)) {
        return { kind: 'usage', detail: `--runner-exit needs a number, and was given '${value}'` }
      }
      runnerExit = code
    } else if (arg.startsWith('--')) {
      return { kind: 'usage', detail: `unknown option '${arg}'` }
    } else {
      paths.push(arg)
    }
  }

  if (paths.length !== 1) {
    const detail =
      paths.length === 0 ? 'no report path was given' : `${paths.length} report paths were given`
    return { kind: 'usage', detail }
  }
  return { kind: 'parsed', path: paths[0], label, runnerExit }
}

function main(argv) {
  const parsed = parseArgs(argv.slice(2))
  if (parsed.kind === 'usage') {
    console.error(`${parsed.detail}\n${USAGE}`)
    return 1
  }
  const { path, label, runnerExit } = parsed

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
  const found = problems(summary, label, runnerExit)
  for (const problem of found) console.error(problem)
  if (found.length === 0 && summary.kind === 'read') {
    console.log(`${label}: ${summary.executed} spec(s) executed, all passed.`)
  }
  return found.length === 0 ? 0 : 1
}

// The main-module guard every other script here uses. Comparing `import.meta.filename` instead
// reads as equivalent and is not: it arrived in Node 20.11, and this repo's engines admit `>=20`,
// so on 20.0 through 20.10 the comparison is `undefined === <path>` and the whole grade silently
// does not happen (no output, exit 0). For a grader that is precisely the pass it exists to
// withhold, which is why it matches its siblings rather than being clever alone.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv)
}
